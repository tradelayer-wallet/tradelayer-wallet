//! Orderbook login: how the relay authenticates the addresses the UI trades with, so that
//! `tl-orderbook-server` (branch `auth`) accepts their orders, and the page never holds a key or a
//! session token.
//!
//! ## Protocol (server: `routes/auth.route.ts`, `services/socket/manager_class.ts`)
//!
//! 1. `GET <origin>/auth/challenge` answers `{nonce, message, expiresAt}`.
//! 2. The address signs `message`: BIP-322 simple for segwit and taproot addresses, BIP-137 for
//!    P2PKH ([`crate::bip322`], [`crate::authsign`]).
//! 3. `POST <origin>/auth/verify` `{address, message, signature}` answers `{token, expiresAt}`
//!    (10 minutes).
//! 4. The relay sends `{event: "auth", token}` on its WebSocket and the server answers
//!    `auth_ok {address, expiresAt}`. A socket may authenticate several addresses.
//!
//! The HTTP origin is the WebSocket origin (`ws` to `http`, `wss` to `https`, same host and port),
//! so the `orderbook_urls` allowlist covers it. Nothing else is contacted.
//!
//! ## What the relay does
//!
//! * The server's hello (`connected`) says whether `authRequired`. If not, nothing here runs.
//! * A mutating UI event (`new-order`, `many-orders`, `amend-order`, `close-order`) names its
//!   trading addresses (`keypair.address`, `address`, `order.keypair.address`, `order.address`;
//!   `close-order` and `amend-order` carry none and use the connection's active address) and its
//!   network (`network`, else the last network the UI named). An address that is not logged in is
//!   logged in first; the event waits in a bounded queue (in order, [`AuthTiming::queue_timeout_ms`])
//!   and is forwarded on `auth_ok`. A failed login sends the UI `OB_SOCKET::order:error`.
//! * A login runs on a short-lived worker thread (HTTP with 5 s timeouts, signing through the
//!   `legacy` thread that owns the keys and the node connection), so the relay loop never blocks.
//! * Tokens exist only inside the worker and for the instant of the `auth` frame. They are never
//!   stored, never logged and never in anything sent to the UI; `auth_ok` is relayed without any
//!   token field.
//! * A login is renewed at [`AuthTiming::renew_percent`] of its lifetime. After a loss of the
//!   connection, a hand-over to a new client, or a resume from sleep, the relay logs the known
//!   addresses in again as soon as the hello arrives.
//! * [`AuthHub::forget_all`] (UI logout, lock, `stop-wallet-node`) makes every client forget its
//!   addresses and queued events.
//! * A failed login is not retried for [`AuthTiming::cooldown_ms`]; events for that address fail at
//!   once meanwhile. At most [`MAX_ADDRESSES`] addresses, [`MAX_PENDING`] queued events and
//!   [`MAX_LOGIN_WORKERS`] concurrent logins exist.
//!
//! [`AuthState`] is the pure state machine (time is an argument, effects are returned as
//! [`Action`]s); the I/O lives in [`spawn_login`] and in the relay loop of [`crate::obrelay`].

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::Duration;

/// UI events that change orders; the server refuses them from an unauthenticated address.
pub const MUTATING_EVENTS: [&str; 4] = ["new-order", "many-orders", "amend-order", "close-order"];
/// Mutating events waiting for a login.
pub const MAX_PENDING: usize = 16;
/// Addresses one connection tracks.
pub const MAX_ADDRESSES: usize = 16;
/// Addresses one request may name.
const MAX_NEEDS: usize = 8;
const MAX_ADDRESS_LEN: usize = 100;
const MAX_NETWORK_LEN: usize = 32;
/// Logins in flight across all clients.
pub const MAX_LOGIN_WORKERS: usize = 8;
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_HTTP_BODY: usize = 64 * 1024;
const MAX_CHALLENGE_BYTES: usize = 1024;
/// The server's session length, and the longest lifetime the relay plans with (a skewed clock
/// must not delay a renewal past it).
const DEFAULT_LIFETIME_MS: u64 = 10 * 60 * 1000;

/// Timing, in milliseconds. [`Default`] is what ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthTiming {
    /// How long a mutating event waits for its login.
    pub queue_timeout_ms: u64,
    /// How long a sent `auth` waits for `auth_ok`.
    pub auth_ok_timeout_ms: u64,
    /// How long a login worker may take before it is given up on.
    pub login_timeout_ms: u64,
    /// After a failed login the address is not tried again for this long.
    pub cooldown_ms: u64,
    /// A login is renewed at this share of its lifetime.
    pub renew_percent: u64,
    /// Shortest lifetime the relay plans with (guards against clock skew making it tiny).
    pub min_lifetime_ms: u64,
}

impl Default for AuthTiming {
    fn default() -> AuthTiming {
        AuthTiming {
            queue_timeout_ms: 15_000,
            auth_ok_timeout_ms: 5_000,
            login_timeout_ms: 20_000,
            cooldown_ms: 5_000,
            renew_percent: 80,
            min_lifetime_ms: 30_000,
        }
    }
}

// ------------------------------------------------------------------ token

/// A session token. It has no `Display`, its `Debug` is redacted and its memory is overwritten on
/// drop.
pub struct Token(String);

impl Token {
    pub fn new(s: String) -> Token {
        Token(s)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

impl Drop for Token {
    fn drop(&mut self) {
        let mut b = std::mem::take(&mut self.0).into_bytes();
        b.fill(0);
    }
}

// ------------------------------------------------------------------ actions

/// What the relay loop must do next.
#[derive(Debug)]
pub enum Action {
    /// Start a login worker for `address` on `network`; its result carries `ticket`.
    Login {
        ticket: u64,
        network: String,
        address: String,
    },
    /// Send `{event: "auth", token}` to the server.
    SendAuth { token: Token },
    /// Send this UI event to the server.
    Forward {
        name: String,
        payload: Option<Value>,
    },
    /// Tell the UI (`OB_SOCKET::order:error`).
    FailUi { message: String },
}

// ------------------------------------------------------------------ state machine

enum Act {
    Idle,
    LoggingIn { ticket: u64, since: u64 },
    AwaitingOk { since: u64, lifetime_ms: u64 },
    Cooling { until: u64, reason: String },
}

struct Entry {
    network: String,
    /// The login is good until this time (ms, monotonic).
    valid_until: Option<u64>,
    renew_at: Option<u64>,
    act: Act,
}

struct Queued {
    name: String,
    payload: Option<Value>,
    needs: Vec<String>,
    deadline: u64,
}

/// Per-connection login state. Pure: time comes in as `now` (monotonic ms) and `wall` (epoch ms).
pub struct AuthState {
    timing: AuthTiming,
    /// The hello's `authRequired`; `None` until the hello arrived.
    required: Option<bool>,
    entries: Vec<(String, Entry)>,
    queue: VecDeque<Queued>,
    next_ticket: u64,
    active: Option<String>,
    last_network: Option<String>,
}

fn clip(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for k in path {
        cur = cur.get(*k)?;
    }
    cur.as_str().filter(|s| !s.is_empty())
}

/// The trading address a UI order names, in the order the server's `resolveTraderAddress` looks.
fn order_address(o: &Value) -> Option<&str> {
    [
        &["keypair", "address"][..],
        &["address"],
        &["order", "keypair", "address"],
        &["order", "address"],
    ]
    .iter()
    .find_map(|p| str_at(o, p))
}

fn order_network(o: &Value) -> Option<&str> {
    str_at(o, &["network"]).or_else(|| str_at(o, &["order", "network"]))
}

/// The orders inside one mutating event: `many-orders` carries an array, or `{orders}`.
fn orders_of<'a>(name: &str, p: &'a Value) -> Vec<&'a Value> {
    if name == "many-orders" {
        match p {
            Value::Array(a) => return a.iter().collect(),
            Value::Object(o) => {
                if let Some(Value::Array(a)) = o.get("orders") {
                    return a.iter().collect();
                }
            }
            _ => {}
        }
    }
    vec![p]
}

fn plausible_address(a: &str) -> bool {
    a.len() <= MAX_ADDRESS_LEN && a.bytes().all(|b| b.is_ascii_graphic())
}

fn plausible_network(n: &str) -> bool {
    n.len() <= MAX_NETWORK_LEN && n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Lifetime of a login in ms: from the server's `expiresAt` (epoch ms), clamped to
/// `[min_lifetime_ms, 10 min]`; ten minutes when the server gave none.
fn lifetime_from(expires_at: Option<u64>, wall: u64, t: &AuthTiming) -> u64 {
    match expires_at.filter(|e| *e > 0) {
        Some(e) => e.saturating_sub(wall).clamp(
            t.min_lifetime_ms.min(DEFAULT_LIFETIME_MS),
            DEFAULT_LIFETIME_MS,
        ),
        None => DEFAULT_LIFETIME_MS,
    }
}

impl AuthState {
    /// `seed`: `(address, network)` pairs the previous connection knew; they are logged in again
    /// when the hello arrives.
    pub fn new(timing: AuthTiming, seed: Vec<(String, String)>) -> AuthState {
        let mut s = AuthState {
            timing,
            required: None,
            entries: Vec::new(),
            queue: VecDeque::new(),
            next_ticket: 0,
            active: None,
            last_network: None,
        };
        for (address, network) in seed.into_iter().take(MAX_ADDRESSES) {
            s.entries.push((address, Entry::new(network)));
        }
        s
    }

    /// The addresses and networks tracked, for the next connection.
    pub fn known(&self) -> Vec<(String, String)> {
        self.entries
            .iter()
            .map(|(a, e)| (a.clone(), e.network.clone()))
            .collect()
    }

    /// The connection ended: logins and queued events do not survive it; the addresses do.
    pub fn reset_connection(&mut self) {
        self.required = None;
        self.queue.clear();
        for (_, e) in &mut self.entries {
            e.valid_until = None;
            e.renew_at = None;
            e.act = Act::Idle;
        }
    }

    /// UI logout, lock or stop: forget every address and queued event.
    pub fn forget(&mut self) {
        self.entries.clear();
        self.queue.clear();
        self.active = None;
    }

    #[cfg(test)]
    pub fn queued(&self) -> usize {
        self.queue.len()
    }

    #[cfg(test)]
    pub fn is_logged_in(&self, address: &str, now: u64) -> bool {
        self.entry(address).is_some_and(|e| e.ready(now))
    }

    fn entry(&self, address: &str) -> Option<&Entry> {
        self.entries
            .iter()
            .find(|(a, _)| a.eq_ignore_ascii_case(address))
            .map(|(_, e)| e)
    }

    fn entry_mut(&mut self, address: &str) -> Option<&mut Entry> {
        self.entries
            .iter_mut()
            .find(|(a, _)| a.eq_ignore_ascii_case(address))
            .map(|(_, e)| e)
    }

    /// The `(network, address)` pairs a mutating event needs logged in. Errors are for the UI.
    fn needs(&mut self, name: &str, p: &Value) -> Result<Vec<(String, String)>, String> {
        let top_network = order_network(p).map(str::to_string);
        let mut out: Vec<(String, String)> = Vec::new();
        for o in orders_of(name, p) {
            let Some(addr) = order_address(o) else {
                continue;
            };
            if !plausible_address(addr) {
                return Err("the order names an invalid trading address".into());
            }
            let net = order_network(o)
                .map(str::to_string)
                .or_else(|| top_network.clone())
                .or_else(|| self.last_network.clone())
                .ok_or("the order names no network")?;
            if !plausible_network(&net) {
                return Err("the order names an invalid network".into());
            }
            if !out.iter().any(|(_, a)| a.eq_ignore_ascii_case(addr)) {
                out.push((net, addr.to_string()));
            }
            if out.len() > MAX_NEEDS {
                return Err("too many trading addresses in one request".into());
            }
        }
        if out.is_empty() && matches!(name, "close-order" | "amend-order" | "many-orders") {
            // No address on the wire: the connection's active address, or its only one.
            let active = self
                .active
                .clone()
                .or_else(|| (self.entries.len() == 1).then(|| self.entries[0].0.clone()));
            if let Some(addr) = active {
                let net = self
                    .entry(&addr)
                    .map(|e| e.network.clone())
                    .or_else(|| self.last_network.clone());
                if let Some(net) = net {
                    out.push((net, addr));
                }
            }
        }
        Ok(out)
    }

    /// Make sure a login for `address` is on its way. `Err` carries the reason an earlier
    /// attempt failed while the address is cooling down.
    fn want_login(
        &mut self,
        now: u64,
        address: &str,
        acts: &mut Vec<Action>,
    ) -> Result<(), String> {
        let ticket = self.next_ticket + 1;
        let Some(e) = self.entry_mut(address) else {
            return Ok(());
        };
        if e.ready(now) {
            return Ok(());
        }
        if let Act::Cooling { until, reason } = &e.act {
            if *until > now {
                return Err(reason.clone());
            }
            e.act = Act::Idle;
        }
        if matches!(e.act, Act::Idle) {
            e.act = Act::LoggingIn { ticket, since: now };
            let network = e.network.clone();
            let address = self
                .entries
                .iter()
                .find(|(a, _)| a.eq_ignore_ascii_case(address))
                .map(|(a, _)| a.clone())
                .unwrap_or_else(|| address.to_string());
            self.next_ticket = ticket;
            acts.push(Action::Login {
                ticket,
                network,
                address,
            });
        }
        Ok(())
    }

    /// A UI event headed for the server. Non-mutating events pass; a mutating one passes when its
    /// addresses are logged in, else it queues behind a login.
    pub fn handle_ui(&mut self, now: u64, name: String, payload: Option<Value>) -> Vec<Action> {
        if let Some(n) = payload
            .as_ref()
            .and_then(|p| str_at(p, &["network"]))
            .filter(|n| plausible_network(n))
        {
            self.last_network = Some(n.to_string());
        }
        let forward = |name, payload| vec![Action::Forward { name, payload }];
        if !MUTATING_EVENTS.contains(&name.as_str()) || self.required == Some(false) {
            return forward(name, payload);
        }
        let needs = match payload.as_ref() {
            Some(p) => match self.needs(&name, p) {
                Ok(n) => n,
                Err(message) => return vec![Action::FailUi { message }],
            },
            None => Vec::new(),
        };
        if needs.is_empty() {
            // Nothing to prove: the server answers for itself.
            return forward(name, payload);
        }
        let mut acts = Vec::new();
        for (net, addr) in &needs {
            match self.entry_mut(addr) {
                Some(e) => e.network = net.clone(),
                None => {
                    if self.entries.len() >= MAX_ADDRESSES {
                        return vec![Action::FailUi {
                            message: "too many trading addresses for one session".into(),
                        }];
                    }
                    self.entries.push((addr.clone(), Entry::new(net.clone())));
                }
            }
        }
        if matches!(name.as_str(), "new-order" | "many-orders") {
            self.active = needs.last().map(|(_, a)| a.clone());
        }
        let addrs: Vec<String> = needs.into_iter().map(|(_, a)| a).collect();
        if self.required == Some(true) {
            for a in &addrs {
                if let Err(reason) = self.want_login(now, a, &mut acts) {
                    acts.push(Action::FailUi {
                        message: format!("Orderbook login failed: {reason}"),
                    });
                    return acts;
                }
            }
            if self.queue.is_empty() && addrs.iter().all(|a| self.ready(a, now)) {
                acts.extend(forward(name, payload));
                return acts;
            }
        }
        if self.queue.len() >= MAX_PENDING {
            acts.push(Action::FailUi {
                message: "too many orders are waiting for the orderbook login".into(),
            });
            return acts;
        }
        self.queue.push_back(Queued {
            name,
            payload,
            needs: addrs,
            deadline: now.saturating_add(self.timing.queue_timeout_ms),
        });
        acts
    }

    fn ready(&self, address: &str, now: u64) -> bool {
        self.entry(address).is_some_and(|e| e.ready(now))
    }

    /// The server's hello: whether it wants a login at all.
    pub fn on_hello(&mut self, now: u64, auth_required: bool) -> Vec<Action> {
        self.required = Some(auth_required);
        let mut acts = Vec::new();
        if auth_required {
            let mut wanted: Vec<String> = self
                .queue
                .iter()
                .flat_map(|q| q.needs.iter().cloned())
                .collect();
            wanted.extend(self.entries.iter().map(|(a, _)| a.clone()));
            let mut seen: Vec<String> = Vec::new();
            for a in wanted {
                if seen.iter().any(|s| s.eq_ignore_ascii_case(&a)) {
                    continue;
                }
                seen.push(a.clone());
                if let Err(reason) = self.want_login(now, &a, &mut acts) {
                    self.fail_waiting(&a, &reason, &mut acts);
                }
            }
        }
        self.flush(now, &mut acts);
        acts
    }

    /// A login worker finished.
    pub fn on_login_result(
        &mut self,
        now: u64,
        wall: u64,
        ticket: u64,
        address: &str,
        result: Result<(Token, u64), String>,
    ) -> Vec<Action> {
        let mut acts = Vec::new();
        let cooldown = self.timing.cooldown_ms;
        let t = self.timing;
        let Some(e) = self.entry_mut(address) else {
            return acts;
        };
        if !matches!(e.act, Act::LoggingIn { ticket: k, .. } if k == ticket) {
            return acts;
        }
        match result {
            Ok((token, expires_at)) => {
                e.act = Act::AwaitingOk {
                    since: now,
                    lifetime_ms: lifetime_from(Some(expires_at), wall, &t),
                };
                acts.push(Action::SendAuth { token });
            }
            Err(reason) => {
                e.cool(now, cooldown, reason.clone());
                self.fail_waiting(address, &reason, &mut acts);
            }
        }
        acts
    }

    /// The server's `auth_ok` for `address`.
    pub fn on_auth_ok(
        &mut self,
        now: u64,
        wall: u64,
        address: &str,
        expires_at: Option<u64>,
    ) -> Vec<Action> {
        let t = self.timing;
        let mut acts = Vec::new();
        let Some(e) = self.entry_mut(address) else {
            return acts;
        };
        let Act::AwaitingOk { lifetime_ms, .. } = e.act else {
            return acts;
        };
        let life = match expires_at {
            Some(x) if x > 0 => lifetime_from(Some(x), wall, &t),
            _ => lifetime_ms,
        };
        e.valid_until = Some(now.saturating_add(life));
        e.renew_at = Some(now.saturating_add(life * t.renew_percent.min(100) / 100));
        e.act = Act::Idle;
        let addr = address.to_string();
        if self.active.is_none() {
            self.active = Some(addr);
        }
        self.flush(now, &mut acts);
        acts
    }

    /// Fail every queued event that waits for `address`.
    fn fail_waiting(&mut self, address: &str, reason: &str, acts: &mut Vec<Action>) {
        let msg = format!("Orderbook login failed: {}", clip(reason, 200));
        let before = self.queue.len();
        self.queue
            .retain(|q| !q.needs.iter().any(|a| a.eq_ignore_ascii_case(address)));
        for _ in self.queue.len()..before {
            acts.push(Action::FailUi {
                message: msg.clone(),
            });
        }
    }

    /// Forward queued events from the head while their addresses are logged in.
    fn flush(&mut self, now: u64, acts: &mut Vec<Action>) {
        while let Some(head) = self.queue.front() {
            let ok = self.required == Some(false)
                || (self.required == Some(true) && head.needs.iter().all(|a| self.ready(a, now)));
            if !ok {
                break;
            }
            if let Some(q) = self.queue.pop_front() {
                acts.push(Action::Forward {
                    name: q.name,
                    payload: q.payload,
                });
            }
        }
    }

    /// Time: expire waits, give up on stuck logins, renew.
    pub fn tick(&mut self, now: u64) -> Vec<Action> {
        let mut acts = Vec::new();
        // Queued events that waited too long.
        let before = self.queue.len();
        self.queue.retain(|q| q.deadline > now);
        for _ in self.queue.len()..before {
            acts.push(Action::FailUi {
                message: "Orderbook login timed out".into(),
            });
        }
        // Logins that never finished.
        let t = self.timing;
        let mut failed: Vec<(String, &str)> = Vec::new();
        for (a, e) in &mut self.entries {
            match &e.act {
                Act::LoggingIn { since, .. }
                    if now.saturating_sub(*since) >= t.login_timeout_ms =>
                {
                    failed.push((a.clone(), "the login took too long"));
                }
                Act::AwaitingOk { since, .. }
                    if now.saturating_sub(*since) >= t.auth_ok_timeout_ms =>
                {
                    failed.push((a.clone(), "the orderbook did not confirm the login"));
                }
                _ => {}
            }
        }
        for (a, reason) in failed {
            if let Some(e) = self.entry_mut(&a) {
                e.cool(now, t.cooldown_ms, reason.to_string());
            }
            self.fail_waiting(&a, reason, &mut acts);
        }
        // Cooled-down entries: drop the ones that never logged in, free the rest.
        self.entries.retain(|(_, e)| {
            !(matches!(&e.act, Act::Cooling { until, .. } if *until <= now)
                && e.valid_until.is_none_or(|v| v <= now))
        });
        for (_, e) in &mut self.entries {
            if matches!(&e.act, Act::Cooling { until, .. } if *until <= now) {
                e.act = Act::Idle;
            }
        }
        // Renewals.
        if self.required == Some(true) {
            let due: Vec<String> = self
                .entries
                .iter()
                .filter(|(_, e)| matches!(e.act, Act::Idle) && e.renew_at.is_some_and(|r| r <= now))
                .map(|(a, _)| a.clone())
                .collect();
            for a in due {
                self.start_renewal(now, &a, &mut acts);
            }
        }
        self.flush(now, &mut acts);
        acts
    }

    /// Renew a login that is still valid: the address stays usable while the new one is made.
    fn start_renewal(&mut self, now: u64, address: &str, acts: &mut Vec<Action>) {
        let ticket = self.next_ticket + 1;
        let Some(e) = self.entry_mut(address) else {
            return;
        };
        e.renew_at = None;
        e.act = Act::LoggingIn { ticket, since: now };
        let network = e.network.clone();
        let address = self
            .entries
            .iter()
            .find(|(a, _)| a.eq_ignore_ascii_case(address))
            .map(|(a, _)| a.clone())
            .unwrap_or_else(|| address.to_string());
        self.next_ticket = ticket;
        acts.push(Action::Login {
            ticket,
            network,
            address,
        });
    }
}

impl Entry {
    fn new(network: String) -> Entry {
        Entry {
            network,
            valid_until: None,
            renew_at: None,
            act: Act::Idle,
        }
    }

    fn ready(&self, now: u64) -> bool {
        self.valid_until.is_some_and(|v| v > now)
    }

    /// A login attempt failed: no new one for `cooldown` ms. A login that is still valid is
    /// renewed again after the pause.
    fn cool(&mut self, now: u64, cooldown: u64, reason: String) {
        let until = now.saturating_add(cooldown);
        self.act = Act::Cooling { until, reason };
        if self.valid_until.is_some() {
            self.renew_at = Some(until);
        }
    }
}

// ------------------------------------------------------------------ hub, signer, login worker

/// Signs the server's challenge for an address. Blocking; implemented over the `legacy` thread,
/// which owns the keys and the node connection.
pub trait AuthSigner: Send + Sync {
    /// The signature the server expects: base64 BIP-322 simple, or BIP-137 for P2PKH.
    fn sign(&self, network: &str, address: &str, message: &str) -> Result<String, String>;
}

/// What every relay client shares: the signer, the logout epoch and the timing.
pub struct AuthHub {
    epoch: AtomicU64,
    signer: OnceLock<Box<dyn AuthSigner>>,
    timing: AuthTiming,
    workers: Arc<AtomicUsize>,
}

impl AuthHub {
    pub fn new() -> Arc<AuthHub> {
        AuthHub::with_timing(AuthTiming::default())
    }

    pub fn with_timing(timing: AuthTiming) -> Arc<AuthHub> {
        Arc::new(AuthHub {
            epoch: AtomicU64::new(0),
            signer: OnceLock::new(),
            timing,
            workers: Arc::new(AtomicUsize::new(0)),
        })
    }

    /// Install the signer once; later calls are ignored.
    pub fn set_signer(&self, signer: Box<dyn AuthSigner>) {
        let _ = self.signer.set(signer);
    }

    pub fn timing(&self) -> AuthTiming {
        self.timing
    }

    #[cfg(test)]
    pub fn signer(&self) -> Option<&dyn AuthSigner> {
        self.signer.get().map(|s| &**s)
    }

    /// Every client forgets its addresses and queued events when it next looks.
    pub fn forget_all(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }

    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }
}

/// A finished login.
pub struct LoginDone {
    pub ticket: u64,
    pub address: String,
    /// The token and the server's `expiresAt` (epoch ms), or the reason.
    pub result: Result<(Token, u64), String>,
}

struct WorkerGuard(Arc<AtomicUsize>);

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// `http://host:port` (or `https`) for a `ws://` (`wss://`) orderbook URL: same host and port.
pub fn http_base(url: &reqwest::Url) -> Option<String> {
    let scheme = match url.scheme() {
        "ws" | "http" => "http",
        "wss" | "https" => "https",
        _ => return None,
    };
    let host = url.host_str()?;
    Some(match url.port() {
        Some(p) => format!("{scheme}://{host}:{p}"),
        None => format!("{scheme}://{host}"),
    })
}

pub fn wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Run a login on its own thread; the outcome arrives on `tx`. `Err` when no worker could start.
pub fn spawn_login(
    hub: &Arc<AuthHub>,
    base: String,
    network: String,
    address: String,
    ticket: u64,
    tx: mpsc::Sender<LoginDone>,
) -> Result<(), String> {
    if hub.workers.fetch_add(1, Ordering::SeqCst) >= MAX_LOGIN_WORKERS {
        hub.workers.fetch_sub(1, Ordering::SeqCst);
        return Err("too many logins in flight".into());
    }
    let guard = WorkerGuard(hub.workers.clone());
    let hub = hub.clone();
    std::thread::Builder::new()
        .name("obauth".into())
        .spawn(move || {
            let _guard = guard;
            let result = login(&hub, &base, &network, &address);
            let _ = tx.send(LoginDone {
                ticket,
                address,
                result,
            });
        })
        .map(|_| ())
        .map_err(|_| "could not start the login".to_string())
}

fn http_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "the orderbook timed out".into()
    } else if e.is_connect() {
        "the orderbook is unreachable".into()
    } else {
        "the orderbook request failed".into()
    }
}

/// The server's own `error` text from a failed answer, if it is plain text.
fn server_reason(body: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(body).ok()?;
    let m = v.get("error").and_then(Value::as_str)?;
    Some(clip(m, 120)).filter(|m| !m.is_empty())
}

fn read_answer(resp: reqwest::blocking::Response, what: &str) -> Result<(u16, Vec<u8>), String> {
    if resp
        .content_length()
        .is_some_and(|n| n > MAX_HTTP_BODY as u64)
    {
        return Err(format!("{what}: answer too large"));
    }
    let status = resp.status().as_u16();
    let body = crate::legacy::read_bounded(resp, MAX_HTTP_BODY)
        .map_err(|_| format!("{what}: answer unreadable"))?;
    Ok((status, body))
}

/// The whole login: challenge, signature, verify. Blocking; at most two HTTP calls of
/// [`HTTP_TIMEOUT`] plus the signing wait.
fn login(hub: &AuthHub, base: &str, network: &str, address: &str) -> Result<(Token, u64), String> {
    let signer = hub.signer.get().ok_or("signing is not available")?;
    let url = reqwest::Url::parse(base).map_err(|_| "the orderbook URL is unusable".to_string())?;
    let client = crate::legacy::http_client_with(&url, HTTP_TIMEOUT, HTTP_TIMEOUT)?;

    let resp = client
        .get(format!("{base}/auth/challenge"))
        .send()
        .map_err(|e| http_error(&e))?;
    let (status, body) = read_answer(resp, "challenge")?;
    if status != 200 {
        return Err(format!("the challenge request failed (HTTP {status})"));
    }
    let ch: Value = serde_json::from_slice(&body)
        .map_err(|_| "the challenge answer is not JSON".to_string())?;
    let message = ch
        .get("message")
        .and_then(Value::as_str)
        .ok_or("the challenge has no message")?;
    let nonce = ch
        .get("nonce")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty())
        .ok_or("the challenge has no nonce")?;
    if message.is_empty()
        || message.len() > MAX_CHALLENGE_BYTES
        || message.contains('\0')
        || !message.contains(nonce)
    {
        return Err("the challenge is malformed".into());
    }

    let signature = signer
        .sign(network, address, message)
        .map_err(|e| format!("signing failed: {}", clip(&e, 160)))?;

    let resp = client
        .post(format!("{base}/auth/verify"))
        .header("Content-Type", "application/json")
        .body(json!({"address": address, "message": message, "signature": signature}).to_string())
        .send()
        .map_err(|e| http_error(&e))?;
    let (status, body) = read_answer(resp, "verify")?;
    if status != 200 {
        return Err(match server_reason(&body) {
            Some(r) => format!("the orderbook refused the login: {r}"),
            None => format!("the orderbook refused the login (HTTP {status})"),
        });
    }
    let v: Value =
        serde_json::from_slice(&body).map_err(|_| "the login answer is not JSON".to_string())?;
    let token = ["token", "sessionToken"]
        .iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .filter(|t| !t.is_empty() && t.len() <= 512)
        .ok_or("the login answer has no token")?;
    let expires_at = v.get("expiresAt").and_then(Value::as_u64).unwrap_or(0);
    Ok((Token::new(token.to_string()), expires_at))
}

/// Remove token fields from a server message before the UI sees it.
pub fn scrub_tokens(v: &mut Value) {
    if let Value::Object(o) = v {
        o.remove("token");
        o.remove("sessionToken");
    }
}

#[cfg(test)]
#[path = "obauth_tests.rs"]
pub(crate) mod tests;
