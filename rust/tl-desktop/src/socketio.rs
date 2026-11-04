//! The legacy UI's main socket.io connection, served from Rust.
//!
//! `packages/wallet-fe` opens `io("http://tlapi.localhost", { reconnection: false })` (socket.io
//! client 4.5.1). The `tlapi` scheme handler hands every `/socket.io/` request to this module,
//! which speaks Engine.IO v4 over **long polling only** (the open packet advertises
//! `"upgrades":[]`, so the client never attempts a WebSocket) and socket.io protocol v5 on the
//! default namespace.
//!
//! The protocol state machine ([`Engine`]) is single-threaded, takes the time as an argument and
//! owns no I/O, so tests drive it with a hand-set clock. [`start`] runs it on its own `socketio`
//! thread: requests arrive over a bounded channel, held long-poll responders wait in the engine,
//! and the thread sleeps until the next deadline (poll timeout, session expiry or block probe).
//! Nothing here touches Tauri's async runtime.
//!
//! ## Session rules
//!
//! * `GET` without `sid` opens a session: `0{"sid":..,"upgrades":[],"pingInterval":25000,..}`.
//! * `POST ?sid=` carries packets separated by `\x1e`; the reply is `ok`.
//! * `GET ?sid=` is the long poll: queued packets at once, else held until a packet is queued or
//!   `pingInterval` passes, then answered with a ping (`2`). A second `GET` while one is held
//!   answers 400 and closes the session.
//! * At most [`MAX_SESSIONS`] sessions; a session with no poll for `pingInterval + pingTimeout`
//!   expires. Like the legacy server only one socket is current: a namespace connect (`40`)
//!   closes every other session. Request bodies and poll payloads are bounded by
//!   [`MAX_PAYLOAD`]; a session whose queue exceeds [`MAX_QUEUE`] packets is closed.
//!
//! ## Events
//!
//! * client `ob-sockets-connect` (url), `ob-sockets-disconnect` and the orderbook events the UI emits
//!   (`update-orderbook`, `new-order`, `close-order`, `many-orders`, `<socket id>::swap`): the
//!   orderbook relay of [`crate::obrelay`]. The engine checks the URL against the allowlist and
//!   queues [`ObCmd`]s; the thread hands them to the relay [`Manager`] and feeds its [`ObEvent`]s
//!   back as `OB_SOCKET::*` events on the session that asked. A session that closes stops its
//!   client.
//! * Liveness ([`Liveness`]): a UI that reconnects (new session) takes over the orderbook relay of
//!   the session it replaces, also when that session ended by timeout or close, as long as it
//!   arrives within `ob_grace_ms`; it is told the relay's state (`OB_SOCKET::connect` when up,
//!   `OB_SOCKET::disconnect` when the relay lost the server meanwhile). A relay nobody claims
//!   within the grace window is stopped. [`Engine::observe_clock`] compares the monotonic clock
//!   with the wall clock on every loop turn; a gap of `resume_gap_ms` or more (system sleep,
//!   a frozen process) closes every session at once, so the UI reconnects immediately instead of
//!   waiting out its timeouts, and restarts the relay client. A block probe that never answers is
//!   abandoned after [`PROBE_STUCK_MS`].
//! * server `new-block` `{height, header}` and `core-error`: while a socket is connected the
//!   engine asks the [`NodeProbe`] for `getblockchaininfo` every `probe_interval_ms`. `new-block`
//!   is emitted when the height increases; `core-error` once when a node that had answered stops
//!   answering.

use crate::legacy::ALLOWED_ORIGIN;
use crate::obrelay::{self, Manager, ObCmd, ObEvent, ObPolicy};
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tauri::http;

pub const MAX_SESSIONS: usize = 4;
/// Largest request body and largest poll response (the advertised `maxPayload`).
pub const MAX_PAYLOAD: usize = 1_000_000;
pub const MAX_QUEUE: usize = 256;
const QUEUE_DEPTH: usize = 128;
/// Longest the thread sleeps without looking at the clocks, so a resume from sleep is noticed
/// within this time even with no session.
const IDLE_WAIT_MS: u64 = 5_000;
/// A block probe in flight longer than this is considered lost and the next one may start.
pub const PROBE_STUCK_MS: u64 = 30_000;
/// Relay commands queued per engine call; further `Send`s are dropped.
const MAX_OB_OUT: usize = 256;
const SEP: char = '\x1e';

/// Timing, in milliseconds. [`Config::default`] is the legacy server's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Config {
    pub ping_interval_ms: u64,
    pub ping_timeout_ms: u64,
    pub probe_interval_ms: u64,
}

impl Default for Config {
    fn default() -> Config {
        Config {
            ping_interval_ms: 25_000,
            ping_timeout_ms: 20_000,
            probe_interval_ms: 5_000,
        }
    }
}

/// Liveness timing, in milliseconds. Kept apart from [`Config`] (the protocol timing).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Liveness {
    /// How long a relay client survives without a UI session before it is stopped.
    pub ob_grace_ms: u64,
    /// Gap between the monotonic and the wall clock (or a stalled loop) that counts as a resume.
    pub resume_gap_ms: u64,
    /// First delay and cap of the relay client's reconnect backoff.
    pub ob_backoff_base_ms: u64,
    pub ob_backoff_cap_ms: u64,
}

impl Default for Liveness {
    fn default() -> Liveness {
        Liveness {
            ob_grace_ms: 60_000,
            resume_gap_ms: 10_000,
            ob_backoff_base_ms: 500,
            ob_backoff_cap_ms: 10_000,
        }
    }
}

// ------------------------------------------------------------------ requests and responses

/// A `/socket.io/` request as the engine sees it.
#[derive(Debug, Clone)]
pub struct SioRequest {
    pub method: String,
    /// The raw query string, without `?`.
    pub query: String,
    pub body: Vec<u8>,
    pub origin: Option<String>,
}

impl SioRequest {
    pub fn from_http(req: &http::Request<Vec<u8>>) -> SioRequest {
        SioRequest {
            method: req.method().as_str().to_string(),
            query: req.uri().query().unwrap_or("").to_string(),
            body: req.body().clone(),
            origin: req
                .headers()
                .get("origin")
                .map(|v| v.to_str().unwrap_or("<invalid>").to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SioResponse {
    pub status: u16,
    pub body: String,
    pub content_type: &'static str,
    /// Echoed `Access-Control-Allow-Origin` (with credentials); `None` means no CORS headers.
    pub allow_origin: Option<String>,
    pub preflight: bool,
}

const TEXT: &str = "text/plain; charset=UTF-8";
const JSON: &str = "application/json";

impl SioResponse {
    fn text(body: impl Into<String>, origin: Option<&str>) -> SioResponse {
        SioResponse {
            status: 200,
            body: body.into(),
            content_type: TEXT,
            allow_origin: origin.map(str::to_string),
            preflight: false,
        }
    }

    fn error(status: u16, code: u8, message: &str, origin: Option<&str>) -> SioResponse {
        SioResponse {
            status,
            body: format!(r#"{{"code":{code},"message":"{message}"}}"#),
            content_type: JSON,
            allow_origin: origin.map(str::to_string),
            preflight: false,
        }
    }

    pub fn into_response(self) -> http::Response<Vec<u8>> {
        let status = http::StatusCode::from_u16(self.status)
            .unwrap_or(http::StatusCode::INTERNAL_SERVER_ERROR);
        let body = if status == http::StatusCode::NO_CONTENT {
            Vec::new()
        } else {
            self.body.into_bytes()
        };
        let mut b = http::Response::builder()
            .status(status)
            .header("Cache-Control", "no-store")
            .header("Vary", "Origin");
        if !body.is_empty() {
            b = b.header("Content-Type", self.content_type);
        }
        if let Some(o) = &self.allow_origin {
            b = b
                .header("Access-Control-Allow-Origin", o.as_str())
                .header("Access-Control-Allow-Credentials", "true");
            if self.preflight {
                b = b
                    .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                    .header("Access-Control-Allow-Headers", "content-type");
            }
        }
        b.body(body).unwrap_or_else(|_| {
            let mut r = http::Response::new(Vec::new());
            *r.status_mut() = http::StatusCode::INTERNAL_SERVER_ERROR;
            r
        })
    }
}

pub type Respond = Box<dyn FnOnce(SioResponse) + Send>;

// ------------------------------------------------------------------ node probe

/// What one `getblockchaininfo` attempt found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    Info {
        height: u64,
        headers: u64,
    },
    /// No node has been started through `start-wallet-node` (or it was stopped).
    NotConnected,
    /// The node did not answer; the text is what the legacy UI showed.
    Error(String),
    /// The bridge was busy; try again next interval.
    Skip,
}

/// Source of block information; the legacy bridge implements it over its own service thread.
pub trait NodeProbe: Send {
    /// Start one probe. `done` may be called from any thread, once.
    fn probe(&self, done: Box<dyn FnOnce(Probe) + Send>);
}

// ------------------------------------------------------------------ packets

#[derive(Debug, PartialEq)]
enum Packet {
    /// Engine.IO pong (`3`).
    Pong,
    /// Engine.IO close (`1`).
    Close,
    /// socket.io CONNECT (`40`) for the default namespace.
    Connect,
    /// socket.io CONNECT (`40/ns,`) for another namespace.
    ConnectOther(String),
    /// socket.io DISCONNECT (`41`).
    Disconnect,
    /// socket.io EVENT (`42["name", payload, ...]`); only the first argument is kept.
    Event(String, Option<Value>),
    /// Anything else, including malformed packets.
    Ignored,
}

fn namespace_of(rest: &str) -> (Option<&str>, &str) {
    match rest.strip_prefix('/') {
        Some(_) => match rest.split_once(',') {
            Some((ns, tail)) => (Some(ns), tail),
            None => (Some(rest), ""),
        },
        None => (None, rest),
    }
}

fn parse_packet(p: &str) -> Packet {
    let mut chars = p.chars();
    match chars.next() {
        Some('3') => Packet::Pong,
        Some('1') => Packet::Close,
        Some('4') => {
            let body = chars.as_str();
            let mut c = body.chars();
            let kind = c.next();
            let (ns, tail) = namespace_of(c.as_str());
            match kind {
                Some('0') => match ns {
                    None | Some("/") => Packet::Connect,
                    Some(other) => Packet::ConnectOther(other.to_string()),
                },
                Some('1') if matches!(ns, None | Some("/")) => Packet::Disconnect,
                Some('2') if matches!(ns, None | Some("/")) => event_name(tail),
                _ => Packet::Ignored,
            }
        }
        _ => Packet::Ignored,
    }
}

/// `[<ack id digits>]["name", ...args]`; the name is the first element.
fn event_name(tail: &str) -> Packet {
    match obrelay::parse_server_packet(&format!("42{tail}")) {
        obrelay::ServerPacket::Event(name, payload) => Packet::Event(name, payload),
        _ => Packet::Ignored,
    }
}

fn event_packet(name: &str, arg: Option<&str>) -> String {
    let mut v = vec![Value::String(name.to_string())];
    if let Some(a) = arg {
        v.push(Value::String(a.to_string()));
    }
    format!("42{}", Value::Array(v))
}

fn query_get<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v)
}

// ------------------------------------------------------------------ the engine

struct Pending {
    done: Respond,
    deadline_ms: u64,
}

struct Session {
    sid: String,
    last_seen_ms: u64,
    queue: VecDeque<String>,
    pending: Option<Pending>,
    ns_connected: bool,
    /// The queue overflowed; the session is closed at the end of the operation.
    dead: bool,
    probe_inflight: bool,
    probe_sent_ms: u64,
    next_probe_ms: u64,
    last_block: u64,
    node_up: bool,
    core_error_sent: bool,
}

impl Session {
    fn push(&mut self, packet: String) {
        if self.queue.len() >= MAX_QUEUE {
            self.dead = true;
        } else {
            self.queue.push_back(packet);
        }
    }

    /// Up to [`MAX_PAYLOAD`] bytes of queued packets, joined by the record separator.
    fn drain(&mut self) -> String {
        let mut out = String::new();
        while let Some(front) = self.queue.front() {
            if !out.is_empty() && out.len() + front.len() + 1 > MAX_PAYLOAD {
                break;
            }
            if !out.is_empty() {
                out.push(SEP);
            }
            out.push_str(front);
            self.queue.pop_front();
        }
        out
    }
}

/// What the owner must do after [`Engine::tick`].
#[derive(Debug, Default, PartialEq, Eq)]
pub struct TickOut {
    /// Sessions that need a block probe now.
    pub probes: Vec<String>,
    /// Absolute time (ms) of the next deadline, if any session exists.
    pub next_wake_ms: Option<u64>,
}

/// What the engine knows of the relay client's connection to the orderbook server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ObPhase {
    /// Never connected yet.
    Connecting,
    Up,
    /// Was connected and lost the server; the client is retrying.
    Down,
}

pub struct Engine {
    cfg: Config,
    live: Liveness,
    sessions: Vec<Session>,
    policy: ObPolicy,
    /// Generation of the orderbook client the engine last asked for, if it is still wanted.
    ob_live: Option<u64>,
    ob_gen: u64,
    ob_phase: ObPhase,
    /// The server's `connected` hello while the client is up: replayed to a session that takes
    /// the relay over, so the UI learns its orderbook socket id again.
    ob_hello: Option<Value>,
    /// Session that asked for the client; its events go there.
    ob_owner: Option<String>,
    /// The owner's session ended without an explicit stop: the client lives until this time (ms)
    /// unless a new session claims it.
    ob_orphan_until: Option<u64>,
    ob_out: Vec<ObCmd>,
    /// Latest engine time seen, for deadlines set outside an entry point that has one.
    now: u64,
    /// `(monotonic ms, wall ms)` at the previous [`Engine::observe_clock`].
    clock: Option<(u64, u64)>,
}

fn new_id(bytes: usize) -> Option<String> {
    let mut b = vec![0u8; bytes];
    getrandom::fill(&mut b).ok()?;
    Some(b.iter().map(|x| format!("{x:02x}")).collect())
}

impl Engine {
    #[cfg(test)]
    pub fn new(cfg: Config) -> Engine {
        Engine::with_liveness(cfg, ObPolicy::default(), Liveness::default())
    }

    pub fn with_liveness(cfg: Config, policy: ObPolicy, live: Liveness) -> Engine {
        Engine {
            cfg,
            live,
            sessions: Vec::new(),
            policy,
            ob_live: None,
            ob_gen: 0,
            ob_phase: ObPhase::Connecting,
            ob_hello: None,
            ob_owner: None,
            ob_orphan_until: None,
            ob_out: Vec::new(),
            now: 0,
            clock: None,
        }
    }

    #[cfg(test)]
    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    fn find(&self, sid: &str) -> Option<usize> {
        self.sessions.iter().position(|s| s.sid == sid)
    }

    fn expiry_ms(&self) -> u64 {
        self.cfg.ping_interval_ms + self.cfg.ping_timeout_ms
    }

    /// Answer one request. `done` is called now, or later for a held long poll.
    pub fn handle(&mut self, now: u64, req: SioRequest, done: Respond) {
        self.now = self.now.max(now);
        let origin = match req.origin.as_deref() {
            None => None,
            Some(o) if o == ALLOWED_ORIGIN => Some(o),
            Some(_) => return done(SioResponse::error(403, 4, "Forbidden", None)),
        };
        if req.method == "OPTIONS" {
            let mut r = SioResponse::text("", origin);
            r.status = 204;
            r.preflight = true;
            return done(r);
        }
        let bad = |code: u8, msg: &str| SioResponse::error(400, code, msg, origin);
        if query_get(&req.query, "EIO") != Some("4") {
            return done(bad(5, "Unsupported protocol version"));
        }
        if query_get(&req.query, "transport") != Some("polling") {
            return done(bad(0, "Transport unknown"));
        }
        let sid = query_get(&req.query, "sid").filter(|s| !s.is_empty());
        match (req.method.as_str(), sid) {
            ("GET", None) => self.open(now, origin, done),
            ("GET", Some(sid)) => self.poll(now, sid, origin, done),
            ("POST", Some(sid)) => self.post(now, sid, &req.body, origin, done),
            _ => done(bad(2, "Bad handshake method")),
        }
    }

    fn open(&mut self, now: u64, origin: Option<&str>, done: Respond) {
        let Some(sid) = new_id(10) else {
            return done(SioResponse::error(500, 3, "Bad request", origin));
        };
        if self.sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) =
                (0..self.sessions.len()).min_by_key(|&i| self.sessions[i].last_seen_ms)
            {
                self.close(oldest);
            }
        }
        self.sessions.push(Session {
            sid: sid.clone(),
            last_seen_ms: now,
            queue: VecDeque::new(),
            pending: None,
            ns_connected: false,
            dead: false,
            probe_inflight: false,
            probe_sent_ms: now,
            next_probe_ms: now,
            last_block: 0,
            node_up: false,
            core_error_sent: false,
        });
        done(SioResponse::text(
            format!(
                r#"0{{"sid":"{sid}","upgrades":[],"pingInterval":{},"pingTimeout":{},"maxPayload":{MAX_PAYLOAD}}}"#,
                self.cfg.ping_interval_ms, self.cfg.ping_timeout_ms
            ),
            origin,
        ));
    }

    fn poll(&mut self, now: u64, sid: &str, origin: Option<&str>, done: Respond) {
        let Some(i) = self.find(sid) else {
            return done(SioResponse::error(400, 1, "Session ID unknown", origin));
        };
        let deadline_ms = now + self.cfg.ping_interval_ms;
        let s = &mut self.sessions[i];
        s.last_seen_ms = now;
        if s.pending.is_some() {
            self.close(i);
            return done(SioResponse::error(400, 3, "Bad request", origin));
        }
        if s.queue.is_empty() {
            s.pending = Some(Pending {
                done: with_origin(done, origin),
                deadline_ms,
            });
        } else {
            let body = s.drain();
            done(SioResponse::text(body, origin));
        }
    }

    fn post(&mut self, now: u64, sid: &str, body: &[u8], origin: Option<&str>, done: Respond) {
        let Some(i) = self.find(sid) else {
            return done(SioResponse::error(400, 1, "Session ID unknown", origin));
        };
        if body.len() > MAX_PAYLOAD {
            return done(SioResponse::error(413, 3, "Payload too large", origin));
        }
        let Ok(text) = std::str::from_utf8(body) else {
            return done(SioResponse::error(400, 3, "Bad request", origin));
        };
        self.sessions[i].last_seen_ms = now;
        let mut closed = false;
        let mut connected_now = false;
        for raw in text.split(SEP) {
            match parse_packet(raw) {
                Packet::Pong | Packet::Ignored => {}
                Packet::Close => {
                    closed = true;
                    break;
                }
                Packet::Connect => {
                    let s = &mut self.sessions[i];
                    if !s.ns_connected {
                        match new_id(10) {
                            Some(nsid) => {
                                s.ns_connected = true;
                                s.next_probe_ms = now;
                                s.push(format!(r#"40{{"sid":"{nsid}"}}"#));
                                connected_now = true;
                            }
                            None => s.push(r#"44{"message":"Invalid namespace"}"#.into()),
                        }
                    }
                }
                Packet::ConnectOther(ns) => {
                    if ns.len() <= 64
                        && ns.bytes().all(|b| b.is_ascii_graphic())
                        && !ns.contains('"')
                    {
                        self.sessions[i]
                            .push(format!(r#"44{ns},{{"message":"Invalid namespace"}}"#));
                    }
                }
                Packet::Disconnect => {
                    self.sessions[i].ns_connected = false;
                    let sid = self.sessions[i].sid.clone();
                    if self.ob_owner.as_deref() == Some(sid.as_str()) {
                        self.ob_stop();
                    }
                }
                Packet::Event(name, payload) => self.on_event(i, &name, payload),
            }
        }
        let sid = self.sessions[i].sid.clone();
        done(SioResponse::text("ok", origin));
        if closed {
            self.close(i);
            return;
        }
        if connected_now {
            // One current socket, like the legacy server: every other session is closed.
            let others: Vec<String> = self
                .sessions
                .iter()
                .filter(|s| s.sid != sid)
                .map(|s| s.sid.clone())
                .collect();
            for o in others {
                if let Some(j) = self.find(&o) {
                    self.close(j);
                }
            }
            self.ob_attach(&sid);
        }
        self.settle(&sid);
    }

    /// Close the session if its queue overflowed, else answer a held poll if packets are queued.
    fn settle(&mut self, sid: &str) {
        let Some(i) = self.find(sid) else { return };
        if self.sessions[i].dead {
            self.close(i);
            return;
        }
        let s = &mut self.sessions[i];
        if !s.queue.is_empty() {
            if let Some(p) = s.pending.take() {
                let body = s.drain();
                (p.done)(SioResponse::text(body, None));
            }
        }
    }

    /// Remove session `i`; a held poll is answered with the Engine.IO close packet. The relay
    /// client of a closed owner is kept for [`Liveness::ob_grace_ms`] so that the UI's next
    /// session can take it over.
    fn close(&mut self, i: usize) {
        let s = self.sessions.remove(i);
        if self.ob_owner.as_deref() == Some(s.sid.as_str()) {
            self.ob_detach();
        }
        if let Some(p) = s.pending {
            (p.done)(SioResponse::text("1", None));
        }
    }

    /// Compare the monotonic clock with the wall clock; call once per loop turn. When the wall
    /// clock ran ahead by `resume_gap_ms` or more (the monotonic clock does not count system
    /// sleep), or the turn itself took that long (a frozen process, a monotonic clock that does
    /// count sleep), the machine was suspended: every session is closed so the UI reconnects now,
    /// and the relay client restarts. Returns whether a resume was detected.
    pub fn observe_clock(&mut self, mono_ms: u64, wall_ms: u64) -> bool {
        self.now = self.now.max(mono_ms);
        let Some((m0, w0)) = self.clock.replace((mono_ms, wall_ms)) else {
            return false;
        };
        let dm = mono_ms.saturating_sub(m0);
        let dw = wall_ms.saturating_sub(w0);
        let gap = dw.saturating_sub(dm).max(dm);
        if gap < self.live.resume_gap_ms {
            return false;
        }
        self.resume();
        true
    }

    fn resume(&mut self) {
        while !self.sessions.is_empty() {
            self.close(self.sessions.len() - 1);
        }
        if self.ob_live.is_some() {
            self.push_ob(ObCmd::Resume);
        }
    }

    // ---- orderbook relay

    /// Commands for the relay [`Manager`], in order.
    pub fn take_ob(&mut self) -> Vec<ObCmd> {
        std::mem::take(&mut self.ob_out)
    }

    fn push_ob(&mut self, cmd: ObCmd) {
        if matches!(cmd, ObCmd::Send { .. }) && self.ob_out.len() >= MAX_OB_OUT {
            return;
        }
        self.ob_out.push(cmd);
    }

    /// Forget the client and tell the relay to close it.
    fn ob_stop(&mut self) {
        if self.ob_live.take().is_some() {
            self.push_ob(ObCmd::Stop);
        }
        self.ob_owner = None;
        self.ob_orphan_until = None;
        self.ob_hello = None;
    }

    /// The owner's session is gone but nobody asked to stop: keep the client for the grace window.
    fn ob_detach(&mut self) {
        self.ob_owner = None;
        if self.ob_live.is_some() {
            self.ob_orphan_until = Some(self.now.saturating_add(self.live.ob_grace_ms));
        }
    }

    /// A UI session connected its namespace: it takes over an unclaimed relay client and learns
    /// the state the UI would have seen had it stayed.
    fn ob_attach(&mut self, sid: &str) {
        if self.ob_live.is_none() || self.ob_owner.is_some() || self.ob_orphan_until.is_none() {
            return;
        }
        let Some(i) = self.find(sid) else { return };
        self.ob_owner = Some(sid.to_string());
        self.ob_orphan_until = None;
        let packet = match self.ob_phase {
            ObPhase::Up => Some(obrelay::connect_packet()),
            ObPhase::Down => Some(obrelay::encode_event("OB_SOCKET::disconnect", None)),
            ObPhase::Connecting => None,
        };
        if let Some(p) = packet {
            self.sessions[i].push(p);
        }
        // The server's hello carries the id the UI needs for its swap channel; the new session
        // never saw it, so it is replayed.
        if self.ob_phase == ObPhase::Up {
            if let Some(hello) = self.ob_hello.clone() {
                self.sessions[i].push(obrelay::encode_event("OB_SOCKET::connected", Some(&hello)));
            }
        }
    }

    fn on_event(&mut self, i: usize, name: &str, payload: Option<Value>) {
        if !self.sessions[i].ns_connected {
            return;
        }
        let sid = self.sessions[i].sid.clone();
        let owns = self.ob_owner.as_deref() == Some(sid.as_str());
        match name {
            "ob-sockets-connect" => self.ob_connect(i, &sid, payload),
            "ob-sockets-disconnect" => {
                if owns {
                    self.ob_stop();
                    self.sessions[i].push(obrelay::encode_event("OB_SOCKET::disconnect", None));
                }
            }
            n if owns && obrelay::outbound_name_ok(n) => {
                if obrelay::ui_payload_ok(payload.as_ref()) {
                    self.push_ob(ObCmd::Send {
                        name: n.to_string(),
                        payload,
                    });
                }
            }
            _ => {}
        }
    }

    /// `ob-sockets-connect`: a new request replaces the current client. A URL outside the
    /// allowlist is refused here, before any network I/O.
    fn ob_connect(&mut self, i: usize, sid: &str, payload: Option<Value>) {
        self.ob_stop();
        let refused = |reason: &str| {
            obrelay::encode_event(
                "OB_SOCKET::connect_error",
                Some(&Value::String(reason.to_string())),
            )
        };
        let Some(Value::String(url)) = payload else {
            self.sessions[i].push(refused("orderbook URL is missing"));
            return;
        };
        match self.policy.check(&url) {
            Err(reason) => self.sessions[i].push(refused(&reason)),
            Ok(url) => {
                self.ob_gen += 1;
                self.ob_live = Some(self.ob_gen);
                self.ob_phase = ObPhase::Connecting;
                self.ob_owner = Some(sid.to_string());
                self.push_ob(ObCmd::Connect {
                    gen: self.ob_gen,
                    url,
                });
            }
        }
    }

    /// An event from the relay client of generation `gen`; stale generations are dropped.
    /// `Disconnected` is not final: the client keeps reconnecting and reports `Connected` again.
    /// `ConnectError` (the first attempt failed) ends the client.
    pub fn ob_event(&mut self, gen: u64, ev: ObEvent) {
        if self.ob_live != Some(gen) {
            return;
        }
        match &ev {
            ObEvent::Connected => self.ob_phase = ObPhase::Up,
            ObEvent::Disconnected => {
                self.ob_phase = ObPhase::Down;
                self.ob_hello = None;
            }
            ObEvent::ConnectError(_) => {}
            ObEvent::Relay { name, payload } => {
                if name == "OB_SOCKET::connected" {
                    self.ob_hello = payload.clone();
                }
            }
        }
        let ended = matches!(ev, ObEvent::ConnectError(_));
        let owner = self.ob_owner.clone();
        let target = owner.as_deref().and_then(|o| self.find(o));
        if owner.is_some() && target.is_none() {
            self.ob_stop();
            return;
        }
        let packet = match ev {
            ObEvent::Connected => obrelay::connect_packet(),
            ObEvent::ConnectError(reason) => {
                obrelay::encode_event("OB_SOCKET::connect_error", Some(&Value::String(reason)))
            }
            ObEvent::Disconnected => obrelay::encode_event("OB_SOCKET::disconnect", None),
            ObEvent::Relay { name, payload } => obrelay::encode_event(&name, payload.as_ref()),
        };
        if ended {
            self.ob_stop();
        }
        // Without an owner (orphaned) only the state is tracked; data would be stale.
        if let (Some(i), Some(owner)) = (target, owner) {
            if packet.len() <= MAX_PAYLOAD {
                self.sessions[i].push(packet);
            }
            self.settle(&owner);
        }
    }

    /// Fire due poll timeouts, expire silent sessions and report which sessions need a probe.
    pub fn tick(&mut self, now: u64) -> TickOut {
        self.now = self.now.max(now);
        let expiry = self.expiry_ms();
        let interval = self.cfg.probe_interval_ms;
        let mut out = TickOut::default();
        let mut i = 0;
        while i < self.sessions.len() {
            let s = &mut self.sessions[i];
            if s.pending.as_ref().is_some_and(|p| p.deadline_ms <= now) {
                if let Some(p) = s.pending.take() {
                    s.last_seen_ms = now;
                    (p.done)(SioResponse::text("2", None));
                }
            }
            if s.pending.is_none() && now.saturating_sub(s.last_seen_ms) > expiry {
                self.close(i);
                continue;
            }
            if s.probe_inflight && now.saturating_sub(s.probe_sent_ms) > PROBE_STUCK_MS {
                s.probe_inflight = false;
            }
            if s.ns_connected && !s.probe_inflight && s.next_probe_ms <= now {
                s.probe_inflight = true;
                s.probe_sent_ms = now;
                s.next_probe_ms = now + interval;
                out.probes.push(s.sid.clone());
            }
            let mut wake = match &s.pending {
                Some(p) => p.deadline_ms,
                None => s.last_seen_ms + expiry + 1,
            };
            if s.ns_connected && !s.probe_inflight {
                wake = wake.min(s.next_probe_ms);
            }
            if s.probe_inflight {
                wake = wake.min(s.probe_sent_ms + PROBE_STUCK_MS + 1);
            }
            out.next_wake_ms = Some(out.next_wake_ms.map_or(wake, |w| w.min(wake)));
            i += 1;
        }
        if let Some(until) = self.ob_orphan_until {
            if until <= now {
                self.ob_stop();
            } else {
                out.next_wake_ms = Some(out.next_wake_ms.map_or(until, |w| w.min(until)));
            }
        }
        out
    }

    /// The result of a probe started for `sid`.
    pub fn probe_result(&mut self, sid: &str, probe: Probe) {
        let Some(i) = self.find(sid) else { return };
        let s = &mut self.sessions[i];
        s.probe_inflight = false;
        match probe {
            Probe::Skip => {}
            Probe::NotConnected => {
                s.node_up = false;
                s.last_block = 0;
                s.core_error_sent = false;
            }
            Probe::Info { height, headers } => {
                s.node_up = true;
                s.core_error_sent = false;
                if height > s.last_block {
                    s.last_block = height;
                    s.push(format!(
                        r#"42["new-block",{{"height":{height},"header":{headers}}}]"#
                    ));
                }
            }
            Probe::Error(text) => {
                if s.node_up && !s.core_error_sent {
                    s.core_error_sent = true;
                    s.push(event_packet("core-error", Some(&text)));
                }
            }
        }
        let sid = s.sid.clone();
        self.settle(&sid);
    }
}

/// Wrap a held responder so its eventual reply carries the CORS origin of the request that
/// started the poll.
fn with_origin(done: Respond, origin: Option<&str>) -> Respond {
    let origin = origin.map(str::to_string);
    Box::new(move |mut r: SioResponse| {
        r.allow_origin = origin;
        done(r)
    })
}

// ------------------------------------------------------------------ the thread

enum Cmd {
    Http(SioRequest, Respond),
    Probe(String, Probe),
    Ob(u64, ObEvent),
    Stop,
}

/// What Tauri's scheme handler holds: a bounded channel to the `socketio` thread.
pub struct Handle {
    tx: mpsc::SyncSender<Cmd>,
}

impl Handle {
    /// Queue one request; `done` receives the reply (possibly much later, for a long poll).
    pub fn serve(&self, req: SioRequest, done: Respond) {
        let origin = req.origin.clone().filter(|o| o == ALLOWED_ORIGIN);
        if let Err(e) = self.tx.try_send(Cmd::Http(req, done)) {
            let (mpsc::TrySendError::Full(c) | mpsc::TrySendError::Disconnected(c)) = e;
            if let Cmd::Http(_, done) = c {
                done(SioResponse::error(503, 3, "Bridge busy", origin.as_deref()));
            }
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        let _ = self.tx.try_send(Cmd::Stop);
    }
}

fn elapsed_ms(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Start the `socketio` thread with the default [`Liveness`].
pub fn start(source: Box<dyn NodeProbe>, cfg: Config, policy: ObPolicy) -> std::io::Result<Handle> {
    start_with(source, cfg, policy, Liveness::default())
}

/// Start the `socketio` thread.
pub fn start_with(
    source: Box<dyn NodeProbe>,
    cfg: Config,
    policy: ObPolicy,
    live: Liveness,
) -> std::io::Result<Handle> {
    let (tx, rx) = mpsc::sync_channel::<Cmd>(QUEUE_DEPTH);
    let probe_tx = tx.clone();
    let ob_tx = tx.clone();
    std::thread::Builder::new()
        .name("socketio".into())
        .spawn(move || {
            let start = Instant::now();
            let mut engine = Engine::with_liveness(cfg, policy, live);
            let mut relay = Manager::new(
                Arc::new(move |gen, ev| ob_tx.send(Cmd::Ob(gen, ev)).is_ok()),
                obrelay::Reconnect {
                    base_ms: live.ob_backoff_base_ms,
                    cap_ms: live.ob_backoff_cap_ms,
                },
            );
            loop {
                let now = elapsed_ms(start);
                engine.observe_clock(now, wall_ms());
                let out = engine.tick(now);
                // Relay commands queued by the last step; a client that cannot start reports at once.
                let mut cmds = engine.take_ob();
                while !cmds.is_empty() {
                    for cmd in cmds {
                        if let Some((gen, ev)) = relay.apply(cmd) {
                            engine.ob_event(gen, ev);
                        }
                    }
                    cmds = engine.take_ob();
                }
                for sid in out.probes {
                    let tx = probe_tx.clone();
                    source.probe(Box::new(move |p| {
                        let _ = tx.send(Cmd::Probe(sid, p));
                    }));
                }
                let wait = out
                    .next_wake_ms
                    .map_or(IDLE_WAIT_MS, |w| w.saturating_sub(now).min(IDLE_WAIT_MS))
                    .max(1);
                match rx.recv_timeout(Duration::from_millis(wait)) {
                    Ok(Cmd::Http(req, done)) => engine.handle(elapsed_ms(start), req, done),
                    Ok(Cmd::Probe(sid, p)) => engine.probe_result(&sid, p),
                    Ok(Cmd::Ob(gen, ev)) => engine.ob_event(gen, ev),
                    Ok(Cmd::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
            }
        })?;
    Ok(Handle { tx })
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    type Slot = Arc<Mutex<Option<SioResponse>>>;

    fn slot() -> (Slot, Respond) {
        let s: Slot = Arc::new(Mutex::new(None));
        let s2 = s.clone();
        (s, Box::new(move |r| *s2.lock().unwrap() = Some(r)))
    }

    fn taken(s: &Slot) -> Option<SioResponse> {
        s.lock().unwrap().take()
    }

    const Q: &str = "EIO=4&transport=polling";

    fn request(method: &str, query: &str, body: &str) -> SioRequest {
        SioRequest {
            method: method.into(),
            query: query.into(),
            body: body.as_bytes().to_vec(),
            origin: Some(ALLOWED_ORIGIN.into()),
        }
    }

    fn call(
        e: &mut Engine,
        now: u64,
        method: &str,
        query: &str,
        body: &str,
    ) -> Option<SioResponse> {
        let (s, done) = slot();
        e.handle(now, request(method, query, body), done);
        taken(&s)
    }

    fn short() -> Config {
        Config {
            ping_interval_ms: 100,
            ping_timeout_ms: 50,
            probe_interval_ms: 10,
        }
    }

    /// Open a session and return its sid.
    fn open(e: &mut Engine, now: u64) -> String {
        let r = call(e, now, "GET", Q, "").unwrap();
        let v: Value = serde_json::from_str(&r.body[1..]).unwrap();
        v["sid"].as_str().unwrap().to_string()
    }

    fn q(sid: &str) -> String {
        format!("{Q}&sid={sid}")
    }

    fn connect(e: &mut Engine, now: u64, sid: &str) -> String {
        let r = call(e, now, "POST", &q(sid), "40").unwrap();
        assert_eq!(r.body, "ok");
        call(e, now, "GET", &q(sid), "").unwrap().body
    }

    // ---- handshake

    #[test]
    fn handshake_is_an_engine_io_v4_open_packet_without_upgrades() {
        let mut e = Engine::new(Config::default());
        let r = call(&mut e, 0, "GET", &format!("{Q}&t=abc"), "").unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.content_type, "text/plain; charset=UTF-8");
        assert_eq!(r.allow_origin.as_deref(), Some(ALLOWED_ORIGIN));
        assert!(r.body.starts_with("0{"));
        let v: Value = serde_json::from_str(&r.body[1..]).unwrap();
        assert_eq!(v["upgrades"], serde_json::json!([]));
        assert_eq!(v["pingInterval"], 25000);
        assert_eq!(v["pingTimeout"], 20000);
        assert_eq!(v["maxPayload"], 1_000_000);
        assert_eq!(v["sid"].as_str().unwrap().len(), 20);
        let http = r.into_response();
        assert_eq!(
            http.headers()["access-control-allow-origin"],
            ALLOWED_ORIGIN
        );
        assert_eq!(http.headers()["access-control-allow-credentials"], "true");
        assert_eq!(http.headers()["content-type"], "text/plain; charset=UTF-8");
    }

    #[test]
    fn wrong_protocol_transport_or_method_is_400() {
        let mut e = Engine::new(Config::default());
        let r = call(&mut e, 0, "GET", "EIO=3&transport=polling", "").unwrap();
        assert_eq!(
            (r.status, r.body.as_str()),
            (
                400,
                r#"{"code":5,"message":"Unsupported protocol version"}"#
            )
        );
        let r = call(&mut e, 0, "GET", "EIO=4&transport=websocket", "").unwrap();
        assert_eq!(
            (r.status, r.body.as_str()),
            (400, r#"{"code":0,"message":"Transport unknown"}"#)
        );
        let r = call(&mut e, 0, "POST", Q, "40").unwrap();
        assert_eq!(r.status, 400);
        let r = call(&mut e, 0, "PUT", &q("x"), "").unwrap();
        assert_eq!(r.status, 400);
        assert_eq!(e.session_count(), 0);
    }

    #[test]
    fn foreign_origin_is_forbidden_and_preflight_is_answered() {
        let mut e = Engine::new(Config::default());
        let (s, done) = slot();
        let mut r = request("GET", Q, "");
        r.origin = Some("http://evil.example".into());
        e.handle(0, r, done);
        let r = taken(&s).unwrap();
        assert_eq!(r.status, 403);
        assert_eq!(r.allow_origin, None);
        assert_eq!(e.session_count(), 0);

        let r = call(&mut e, 0, "OPTIONS", Q, "").unwrap();
        assert_eq!(r.status, 204);
        let http = r.into_response();
        assert_eq!(
            http.headers()["access-control-allow-origin"],
            ALLOWED_ORIGIN
        );
        assert_eq!(
            http.headers()["access-control-allow-methods"],
            "GET, POST, OPTIONS"
        );
        assert!(http.body().is_empty());
    }

    // ---- namespace and events

    #[test]
    fn namespace_connect_queues_a_sid_reply() {
        let mut e = Engine::new(Config::default());
        let sid = open(&mut e, 0);
        let body = connect(&mut e, 1, &sid);
        let v: Value = serde_json::from_str(body.strip_prefix("40").unwrap()).unwrap();
        assert_eq!(v["sid"].as_str().unwrap().len(), 20);
        assert_ne!(v["sid"], sid.as_str());
    }

    const OB: &str = "ws://172.81.181.19:3001/ws";

    /// An engine with a connected namespace, plus its sid.
    fn connected_engine() -> (Engine, String) {
        let mut e = Engine::new(short());
        let sid = open(&mut e, 0);
        connect(&mut e, 0, &sid);
        (e, sid)
    }

    fn emit(e: &mut Engine, now: u64, sid: &str, packet: &str) {
        assert_eq!(call(e, now, "POST", &q(sid), packet).unwrap().body, "ok");
    }

    /// Packets queued for the session right now (a poll that would be held yields none).
    fn queued(e: &mut Engine, now: u64, sid: &str) -> Vec<String> {
        let (held, done) = slot();
        e.handle(now, request("GET", &q(sid), ""), done);
        match taken(&held) {
            Some(r) => r.body.split(SEP).map(str::to_string).collect(),
            None => {
                // Release the held poll with its ping so the next call can poll again.
                e.tick(now + 1_000);
                vec![]
            }
        }
    }

    #[test]
    fn packets_in_one_post_are_split_on_the_record_separator() {
        let (mut e, sid) = connected_engine();
        let body = format!(
            "3{SEP}42[\"ob-sockets-connect\",\"ftp://ob.example\"]{SEP}42[\"ob-sockets-connect\",\"{OB}\"]"
        );
        emit(&mut e, 1, &sid, &body);
        // The first request was refused, the second asked for a client.
        let out = queued(&mut e, 1, &sid);
        assert_eq!(
            out,
            vec![
                r#"42["OB_SOCKET::connect_error","orderbook URL must be ws, wss, http or https"]"#
                    .to_string()
            ]
        );
        let cmds = e.take_ob();
        assert!(matches!(cmds.as_slice(), [ObCmd::Connect { gen: 1, .. }]));
    }

    #[test]
    fn ob_sockets_connect_refuses_urls_outside_the_allowlist_without_a_command() {
        let (mut e, sid) = connected_engine();
        let cases = [
            (
                "ws://127.0.0.1:3001/ws",
                "orderbook URL is not in orderbook_urls",
            ),
            (
                "ws://172.81.181.19:3002/ws",
                "orderbook URL is not in orderbook_urls",
            ),
            (
                "ws://172.81.181.19:3001/ns",
                "orderbook URL path must be / or /ws",
            ),
            ("not a url", "orderbook URL is malformed"),
        ];
        for (n, (url, reason)) in cases.iter().enumerate() {
            let packet =
                obrelay::encode_event("ob-sockets-connect", Some(&Value::String((*url).into())));
            let now = 1 + n as u64;
            emit(&mut e, now, &sid, &packet);
            assert_eq!(
                queued(&mut e, now, &sid),
                vec![format!(r#"42["OB_SOCKET::connect_error","{reason}"]"#)],
                "{url}"
            );
        }
        // A missing or non-string URL is refused too.
        emit(&mut e, 9, &sid, r#"42["ob-sockets-connect"]"#);
        emit(&mut e, 9, &sid, r#"42["ob-sockets-connect",{"a":1}]"#);
        assert_eq!(queued(&mut e, 9, &sid).len(), 2);
        assert!(e.take_ob().is_empty());
    }

    #[test]
    fn allowed_connect_queues_one_command_and_the_client_events_reach_the_session() {
        let (mut e, sid) = connected_engine();
        emit(
            &mut e,
            1,
            &sid,
            &format!(r#"42["ob-sockets-connect","{OB}"]"#),
        );
        let cmds = e.take_ob();
        let [ObCmd::Connect { gen, url }] = cmds.as_slice() else {
            panic!("{cmds:?}")
        };
        assert_eq!((*gen, url.as_str()), (1, "ws://172.81.181.19:3001/ws"));
        // A held poll is released by a relayed event.
        let (held, done) = slot();
        e.handle(2, request("GET", &q(&sid), ""), done);
        e.ob_event(1, ObEvent::Connected);
        assert_eq!(taken(&held).unwrap().body, r#"42["OB_SOCKET::connect",{}]"#);
        e.ob_event(
            1,
            ObEvent::Relay {
                name: "OB_SOCKET::orderbook-data".into(),
                payload: Some(serde_json::json!({"orders": []})),
            },
        );
        assert_eq!(
            queued(&mut e, 3, &sid),
            vec![r#"42["OB_SOCKET::orderbook-data",{"orders":[]}]"#.to_string()]
        );
        // Stale generations are dropped.
        e.ob_event(7, ObEvent::Disconnected);
        assert!(queued(&mut e, 4, &sid).is_empty());
        // A lost connection reaches the UI; the client keeps retrying, so nothing is stopped and
        // its next `Connected` reaches the UI again.
        e.ob_event(1, ObEvent::Disconnected);
        assert_eq!(
            queued(&mut e, 5, &sid),
            vec![r#"42["OB_SOCKET::disconnect"]"#.to_string()]
        );
        assert!(e.take_ob().is_empty());
        e.ob_event(1, ObEvent::Connected);
        assert_eq!(
            queued(&mut e, 6, &sid),
            vec![r#"42["OB_SOCKET::connect",{}]"#.to_string()]
        );
        // A failed first attempt ends the client.
        e.ob_event(1, ObEvent::ConnectError("no".into()));
        assert_eq!(
            queued(&mut e, 7, &sid),
            vec![r#"42["OB_SOCKET::connect_error","no"]"#.to_string()]
        );
        assert!(matches!(e.take_ob().as_slice(), [ObCmd::Stop]));
        e.ob_event(1, ObEvent::Connected);
        assert!(queued(&mut e, 8, &sid).is_empty());
    }

    #[test]
    fn ui_events_are_filtered_and_forwarded_only_while_a_client_exists() {
        let (mut e, sid) = connected_engine();
        emit(&mut e, 1, &sid, r#"42["new-order",{"a":1}]"#);
        assert!(e.take_ob().is_empty());
        emit(
            &mut e,
            1,
            &sid,
            &format!(r#"42["ob-sockets-connect","{OB}"]"#),
        );
        e.take_ob();
        for p in [
            r#"42["new-order",{"a":1}]"#,
            r#"42["update-orderbook"]"#,
            r#"42["close-order","u"]"#,
            r#"42["many-orders",[1,2]]"#,
            r#"42["abc-1::swap",{"s":1}]"#,
            r#"42["evil",1]"#,
            r#"42["OB_SOCKET::connect",{}]"#,
            r#"42["a b::swap",1]"#,
        ] {
            emit(&mut e, 2, &sid, p);
        }
        let sent: Vec<String> = e
            .take_ob()
            .into_iter()
            .map(|c| match c {
                ObCmd::Send { name, .. } => name,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            sent,
            [
                "new-order",
                "update-orderbook",
                "close-order",
                "many-orders",
                "abc-1::swap"
            ]
        );
        // Oversized payloads are dropped.
        let big = obrelay::encode_event(
            "new-order",
            Some(&Value::String("a".repeat(obrelay::MAX_UI_PAYLOAD))),
        );
        emit(&mut e, 3, &sid, &big);
        assert!(e.take_ob().is_empty());
        // A flood is bounded.
        let one = r#"42["new-order",1]"#;
        let flood = vec![one; MAX_OB_OUT + 50].join(&SEP.to_string());
        emit(&mut e, 4, &sid, &flood);
        assert!(e.take_ob().len() <= MAX_OB_OUT);
    }

    #[test]
    fn ob_sockets_disconnect_stops_the_client_and_answers_disconnect() {
        let (mut e, sid) = connected_engine();
        // No client: nothing to disconnect.
        emit(&mut e, 1, &sid, r#"42["ob-sockets-disconnect"]"#);
        assert!(queued(&mut e, 1, &sid).is_empty());
        assert!(e.take_ob().is_empty());
        emit(
            &mut e,
            2,
            &sid,
            &format!(r#"42["ob-sockets-connect","{OB}"]"#),
        );
        e.take_ob();
        emit(&mut e, 3, &sid, r#"42["ob-sockets-disconnect"]"#);
        assert_eq!(
            queued(&mut e, 3, &sid),
            vec![r#"42["OB_SOCKET::disconnect"]"#.to_string()]
        );
        assert!(matches!(e.take_ob().as_slice(), [ObCmd::Stop]));
        // The client is gone: later events are not forwarded.
        emit(&mut e, 4, &sid, r#"42["new-order",1]"#);
        assert!(e.take_ob().is_empty());
    }

    #[test]
    fn a_new_connect_replaces_the_client_and_session_end_stops_it_after_the_grace_window() {
        let (mut e, sid) = connected_engine();
        let url = format!(r#"42["ob-sockets-connect","{OB}"]"#);
        emit(&mut e, 1, &sid, &url);
        emit(&mut e, 1, &sid, &url);
        let cmds = e.take_ob();
        assert!(
            matches!(
                cmds.as_slice(),
                [
                    ObCmd::Connect { gen: 1, .. },
                    ObCmd::Stop,
                    ObCmd::Connect { gen: 2, .. }
                ]
            ),
            "{cmds:?}"
        );
        // The UI's Engine.IO close ends the session; its client waits out the grace window.
        emit(&mut e, 2, &sid, "1");
        assert_eq!(e.session_count(), 0);
        assert!(e.take_ob().is_empty());
        e.ob_event(2, ObEvent::Connected);
        assert_eq!(e.session_count(), 0);
        e.tick(2 + Liveness::default().ob_grace_ms - 1);
        assert!(e.take_ob().is_empty());
        e.tick(2 + Liveness::default().ob_grace_ms);
        assert!(matches!(e.take_ob().as_slice(), [ObCmd::Stop]));

        // So do the namespace DISCONNECT and an expired session.
        let (mut e, sid) = connected_engine();
        emit(&mut e, 1, &sid, &url);
        e.take_ob();
        emit(&mut e, 2, &sid, "41");
        assert!(matches!(e.take_ob().as_slice(), [ObCmd::Stop]));
        let (mut e, sid) = connected_engine();
        emit(&mut e, 1, &sid, &url);
        e.take_ob();
        e.tick(10_000);
        assert_eq!(e.session_count(), 0);
        assert!(e.take_ob().is_empty());
        e.tick(10_000 + Liveness::default().ob_grace_ms);
        assert!(matches!(e.take_ob().as_slice(), [ObCmd::Stop]));
    }

    #[test]
    fn only_the_session_that_asked_may_drive_the_client() {
        let (mut e, a) = connected_engine();
        emit(
            &mut e,
            1,
            &a,
            &format!(r#"42["ob-sockets-connect","{OB}"]"#),
        );
        e.take_ob();
        // A second session that has not connected its namespace cannot send events.
        let b = open(&mut e, 2);
        emit(&mut e, 2, &b, r#"42["new-order",1]"#);
        emit(&mut e, 2, &b, r#"42["ob-sockets-disconnect"]"#);
        assert!(e.take_ob().is_empty());
    }

    #[test]
    fn events_before_the_namespace_connect_and_unknown_events_are_ignored() {
        let mut e = Engine::new(Config::default());
        let sid = open(&mut e, 0);
        call(
            &mut e,
            0,
            "POST",
            &q(&sid),
            r#"42["ob-sockets-connect","x"]"#,
        )
        .unwrap();
        connect(&mut e, 0, &sid);
        call(&mut e, 0, "POST", &q(&sid), r#"42["something-else",1,2]"#).unwrap();
        let (held, done) = slot();
        e.handle(1, request("GET", &q(&sid), ""), done);
        assert!(taken(&held).is_none());
    }

    #[test]
    fn malformed_packets_are_ignored_without_panicking() {
        let cases = [
            "",
            "4",
            "42",
            "42[",
            "42{}",
            "42[1]",
            "42[]",
            "42[\"a\"",
            "4\u{1f600}",
            "\u{1f600}",
            "99",
            "42/admin,[\"x\"]",
            "421234",
            "42[[\"x\"]]",
            "0",
            "2",
            "5",
        ];
        for c in cases {
            let p = parse_packet(c);
            assert!(
                matches!(p, Packet::Ignored | Packet::ConnectOther(_)),
                "{c:?} parsed as {p:?}"
            );
        }
        let mut e = Engine::new(Config::default());
        let sid = open(&mut e, 0);
        connect(&mut e, 0, &sid);
        let junk = cases.join(&SEP.to_string());
        assert_eq!(call(&mut e, 1, "POST", &q(&sid), &junk).unwrap().body, "ok");
        // Invalid UTF-8 is a 400, not a panic.
        let (s, done) = slot();
        let mut r = request("POST", &q(&sid), "");
        r.body = vec![0xff, 0xfe];
        e.handle(1, r, done);
        assert_eq!(taken(&s).unwrap().status, 400);
        assert_eq!(e.session_count(), 1);
    }

    #[test]
    fn parser_recognises_the_packets_the_client_sends() {
        assert_eq!(parse_packet("3"), Packet::Pong);
        assert_eq!(parse_packet("1"), Packet::Close);
        assert_eq!(parse_packet("40"), Packet::Connect);
        assert_eq!(parse_packet("40{\"token\":1}"), Packet::Connect);
        assert_eq!(
            parse_packet("40/admin,"),
            Packet::ConnectOther("/admin".into())
        );
        assert_eq!(parse_packet("41"), Packet::Disconnect);
        assert_eq!(
            parse_packet("42[\"ob-sockets-disconnect\"]"),
            Packet::Event("ob-sockets-disconnect".into(), None)
        );
        assert_eq!(
            parse_packet("4217[\"a\",{\"b\":1}]"),
            Packet::Event("a".into(), Some(serde_json::json!({"b": 1})))
        );
    }

    #[test]
    fn other_namespaces_are_refused() {
        let mut e = Engine::new(Config::default());
        let sid = open(&mut e, 0);
        call(&mut e, 0, "POST", &q(&sid), "40/admin,").unwrap();
        let out = call(&mut e, 0, "GET", &q(&sid), "").unwrap().body;
        assert_eq!(out, r#"44/admin,{"message":"Invalid namespace"}"#);
    }

    // ---- long polling

    #[test]
    fn poll_returns_queued_packets_at_once_and_holds_otherwise() {
        let mut e = Engine::new(short());
        let sid = open(&mut e, 0);
        let (held, done) = slot();
        e.handle(0, request("GET", &q(&sid), ""), done);
        assert!(taken(&held).is_none());
        // The POST that queues a packet releases the held poll.
        assert_eq!(call(&mut e, 5, "POST", &q(&sid), "40").unwrap().body, "ok");
        let r = taken(&held).unwrap();
        assert!(r.body.starts_with("40{\"sid\":\""));
        assert_eq!(r.allow_origin.as_deref(), Some(ALLOWED_ORIGIN));
    }

    #[test]
    fn held_poll_gets_a_ping_after_the_interval() {
        let mut e = Engine::new(short());
        let sid = open(&mut e, 0);
        let (held, done) = slot();
        e.handle(0, request("GET", &q(&sid), ""), done);
        let t = e.tick(99);
        assert!(taken(&held).is_none());
        assert_eq!(t.next_wake_ms, Some(100));
        e.tick(100);
        let r = taken(&held).unwrap();
        assert_eq!(r.body, "2");
        assert_eq!(r.allow_origin.as_deref(), Some(ALLOWED_ORIGIN));
        assert_eq!(e.session_count(), 1);
    }

    #[test]
    fn second_concurrent_poll_is_400_and_closes_the_session() {
        let mut e = Engine::new(short());
        let sid = open(&mut e, 0);
        let (held, done) = slot();
        e.handle(0, request("GET", &q(&sid), ""), done);
        let r = call(&mut e, 1, "GET", &q(&sid), "").unwrap();
        assert_eq!(r.status, 400);
        assert_eq!(taken(&held).unwrap().body, "1");
        assert_eq!(e.session_count(), 0);
        assert_eq!(call(&mut e, 2, "GET", &q(&sid), "").unwrap().status, 400);
    }

    #[test]
    fn unknown_sid_is_400_with_the_engine_io_error() {
        let mut e = Engine::new(Config::default());
        for m in ["GET", "POST"] {
            let r = call(&mut e, 0, m, &q("nope"), "3").unwrap();
            assert_eq!(r.status, 400);
            assert_eq!(r.body, r#"{"code":1,"message":"Session ID unknown"}"#);
            assert_eq!(r.content_type, "application/json");
        }
    }

    #[test]
    fn silent_sessions_expire_after_ping_interval_plus_timeout() {
        let mut e = Engine::new(short());
        let sid = open(&mut e, 0);
        e.tick(150);
        assert_eq!(e.session_count(), 1);
        e.tick(151);
        assert_eq!(e.session_count(), 0);
        assert_eq!(call(&mut e, 152, "GET", &q(&sid), "").unwrap().status, 400);
    }

    #[test]
    fn a_polling_session_does_not_expire() {
        let mut e = Engine::new(short());
        let sid = open(&mut e, 0);
        let mut t = 0;
        for _ in 0..10 {
            let (held, done) = slot();
            e.handle(t, request("GET", &q(&sid), ""), done);
            t += 100;
            e.tick(t);
            assert_eq!(taken(&held).unwrap().body, "2");
        }
        assert_eq!(e.session_count(), 1);
    }

    #[test]
    fn oversized_post_is_413_and_the_queue_is_bounded() {
        let mut e = Engine::new(Config::default());
        let sid = open(&mut e, 0);
        let (s, done) = slot();
        let mut r = request("POST", &q(&sid), "");
        r.body = vec![b'3'; MAX_PAYLOAD + 1];
        e.handle(0, r, done);
        assert_eq!(taken(&s).unwrap().status, 413);
        assert_eq!(e.session_count(), 1);

        // Flooding events overflows the queue and closes the session instead of growing it.
        connect(&mut e, 0, &sid);
        let one = r#"42["ob-sockets-connect","ws://x.example"]"#;
        let flood = vec![one; MAX_QUEUE + 5].join(&SEP.to_string());
        assert_eq!(
            call(&mut e, 1, "POST", &q(&sid), &flood).unwrap().body,
            "ok"
        );
        assert_eq!(e.session_count(), 0);
    }

    #[test]
    fn poll_payload_never_exceeds_the_bound() {
        let mut s = Session {
            sid: "x".into(),
            last_seen_ms: 0,
            queue: VecDeque::new(),
            pending: None,
            ns_connected: true,
            dead: false,
            probe_inflight: false,
            probe_sent_ms: 0,
            next_probe_ms: 0,
            last_block: 0,
            node_up: false,
            core_error_sent: false,
        };
        for _ in 0..10 {
            s.queue.push_back("a".repeat(300_000));
        }
        let first = s.drain();
        assert!(first.len() <= MAX_PAYLOAD);
        assert_eq!(first.split(SEP).count(), 3);
        assert_eq!(s.queue.len(), 7);
    }

    // ---- sessions

    #[test]
    fn session_count_is_bounded_and_the_oldest_is_evicted() {
        let mut e = Engine::new(Config::default());
        let sids: Vec<String> = (0..MAX_SESSIONS as u64).map(|t| open(&mut e, t)).collect();
        assert_eq!(e.session_count(), MAX_SESSIONS);
        let newest = open(&mut e, 10);
        assert_eq!(e.session_count(), MAX_SESSIONS);
        assert_eq!(
            call(&mut e, 11, "GET", &q(&sids[0]), "").unwrap().status,
            400
        );
        assert_ne!(
            call(&mut e, 12, "POST", &q(&newest), "3").unwrap().status,
            400
        );
        assert_ne!(
            call(&mut e, 12, "POST", &q(&sids[1]), "3").unwrap().status,
            400
        );
    }

    #[test]
    fn a_new_connection_replaces_the_old_one() {
        let mut e = Engine::new(short());
        let old = open(&mut e, 0);
        connect(&mut e, 0, &old);
        let (held_old, done) = slot();
        e.handle(1, request("GET", &q(&old), ""), done);
        let new = open(&mut e, 2);
        assert_eq!(e.session_count(), 2);
        let body = connect(&mut e, 3, &new);
        assert!(body.starts_with("40"));
        assert_eq!(e.session_count(), 1);
        assert_eq!(taken(&held_old).unwrap().body, "1");
        assert_eq!(call(&mut e, 4, "GET", &q(&old), "").unwrap().status, 400);
        assert_eq!(call(&mut e, 4, "POST", &q(&new), "3").unwrap().body, "ok");
    }

    #[test]
    fn client_close_packet_ends_the_session() {
        let mut e = Engine::new(Config::default());
        let sid = open(&mut e, 0);
        connect(&mut e, 0, &sid);
        let (held, done) = slot();
        e.handle(1, request("GET", &q(&sid), ""), done);
        assert_eq!(call(&mut e, 2, "POST", &q(&sid), "41").unwrap().body, "ok");
        assert_eq!(e.session_count(), 1);
        assert_eq!(call(&mut e, 3, "POST", &q(&sid), "1").unwrap().body, "ok");
        assert_eq!(e.session_count(), 0);
        assert_eq!(taken(&held).unwrap().body, "1");
    }

    // ---- liveness: relay hand-over, clock jumps, stuck probes

    const GRACE: u64 = 60_000;

    /// A connected engine whose client asked for the orderbook and reported `Connected`.
    fn engine_with_relay(now: u64) -> (Engine, String) {
        let (mut e, sid) = connected_engine();
        emit(
            &mut e,
            now,
            &sid,
            &format!(r#"42["ob-sockets-connect","{OB}"]"#),
        );
        assert!(matches!(
            e.take_ob().as_slice(),
            [ObCmd::Connect { gen: 1, .. }]
        ));
        e.ob_event(1, ObEvent::Connected);
        assert_eq!(
            queued(&mut e, now, &sid),
            vec![r#"42["OB_SOCKET::connect",{}]"#.to_string()]
        );
        (e, sid)
    }

    /// Open a second session and connect its namespace; returns its sid and first packets.
    fn reconnect_session(e: &mut Engine, now: u64) -> (String, Vec<String>) {
        let sid = open(e, now);
        emit(e, now, &sid, "40");
        (sid.clone(), queued(e, now, &sid))
    }

    #[test]
    fn a_reconnecting_ui_takes_over_the_relay_within_the_grace_window() {
        let (mut e, old) = engine_with_relay(1);
        // The old session ends by silence (the UI slept): no Stop, the client stays.
        e.tick(1_000);
        assert_eq!(e.session_count(), 0, "{old}");
        assert!(e.take_ob().is_empty());
        let (new, packets) = reconnect_session(&mut e, 1_000 + GRACE - 1);
        assert_eq!(packets.len(), 2, "{packets:?}");
        assert!(packets[0].starts_with("40{"));
        assert_eq!(packets[1], r#"42["OB_SOCKET::connect",{}]"#);
        // No new client was requested, and the new session owns the old one.
        assert!(e.take_ob().is_empty());
        emit(&mut e, 2_000, &new, r#"42["new-order",{"a":1}]"#);
        assert!(matches!(
            e.take_ob().as_slice(),
            [ObCmd::Send { name, .. }] if name == "new-order"
        ));
        e.ob_event(
            1,
            ObEvent::Relay {
                name: "OB_SOCKET::order:saved".into(),
                payload: None,
            },
        );
        assert_eq!(
            queued(&mut e, 2_001, &new),
            vec![r#"42["OB_SOCKET::order:saved"]"#.to_string()]
        );
        // It is no longer an orphan: the grace deadline does not stop it.
        e.tick(1_000 + 2 * GRACE);
        assert!(e.take_ob().is_empty());
    }

    #[test]
    fn a_live_session_is_replaced_by_the_new_one_with_the_relay() {
        let (mut e, _old) = engine_with_relay(1);
        let (new, packets) = reconnect_session(&mut e, 2);
        assert_eq!(e.session_count(), 1);
        assert_eq!(packets.last().unwrap(), r#"42["OB_SOCKET::connect",{}]"#);
        assert!(e.take_ob().is_empty());
        emit(&mut e, 3, &new, r#"42["close-order","u1"]"#);
        assert_eq!(e.take_ob().len(), 1);
    }

    #[test]
    fn an_unclaimed_relay_is_stopped_after_the_grace_window() {
        let (mut e, _old) = engine_with_relay(1);
        e.tick(1_000);
        assert!(e.take_ob().is_empty());
        let out = e.tick(2_000);
        assert_eq!(out.next_wake_ms, Some(1_000 + GRACE));
        e.tick(1_000 + GRACE);
        assert!(matches!(e.take_ob().as_slice(), [ObCmd::Stop]));
        // A session arriving too late gets nothing and owns no client.
        let (new, packets) = reconnect_session(&mut e, 1_000 + GRACE + 1);
        assert_eq!(packets.len(), 1, "{packets:?}");
        emit(&mut e, 1_000 + GRACE + 2, &new, r#"42["new-order",1]"#);
        assert!(e.take_ob().is_empty());
    }

    #[test]
    fn a_relay_that_lost_the_server_while_orphaned_is_reported_down_then_up() {
        let (mut e, _old) = engine_with_relay(1);
        e.tick(1_000);
        // The relay's own events while nobody listens only update its state.
        e.ob_event(1, ObEvent::Disconnected);
        e.ob_event(
            1,
            ObEvent::Relay {
                name: "OB_SOCKET::orderbook-data".into(),
                payload: None,
            },
        );
        let (new, packets) = reconnect_session(&mut e, 2_000);
        assert_eq!(
            packets[1..],
            [r#"42["OB_SOCKET::disconnect"]"#.to_string()],
            "stale data is not replayed"
        );
        e.ob_event(1, ObEvent::Connected);
        assert_eq!(
            queued(&mut e, 2_001, &new),
            vec![r#"42["OB_SOCKET::connect",{}]"#.to_string()]
        );
    }

    #[test]
    fn a_relay_still_connecting_is_handed_over_silently() {
        let (mut e, sid) = connected_engine();
        emit(
            &mut e,
            1,
            &sid,
            &format!(r#"42["ob-sockets-connect","{OB}"]"#),
        );
        e.take_ob();
        let (_new, packets) = reconnect_session(&mut e, 2);
        assert_eq!(packets.len(), 1, "{packets:?}");
        assert!(e.take_ob().is_empty());
    }

    #[test]
    fn deliberate_disconnects_are_not_handed_over() {
        // `ob-sockets-disconnect` and the namespace DISCONNECT stop the client at once.
        for packet in [r#"42["ob-sockets-disconnect"]"#, "41"] {
            let (mut e, sid) = engine_with_relay(1);
            emit(&mut e, 2, &sid, packet);
            assert!(matches!(e.take_ob().as_slice(), [ObCmd::Stop]), "{packet}");
            e.tick(3);
            let (_new, packets) = reconnect_session(&mut e, 4);
            assert!(
                packets.iter().all(|p| !p.contains("OB_SOCKET")),
                "{packet}: {packets:?}"
            );
        }
    }

    #[test]
    fn a_new_connect_request_replaces_the_handed_over_relay() {
        let (mut e, _old) = engine_with_relay(1);
        e.tick(1_000);
        let sid = open(&mut e, 1_500);
        connect(&mut e, 1_500, &sid);
        emit(
            &mut e,
            1_600,
            &sid,
            &format!(r#"42["ob-sockets-connect","{OB}"]"#),
        );
        let cmds = e.take_ob();
        assert!(
            matches!(
                cmds.as_slice(),
                [ObCmd::Stop, ObCmd::Connect { gen: 2, .. }]
            ),
            "{cmds:?}"
        );
    }

    fn live_gap(gap: u64) -> Liveness {
        Liveness {
            resume_gap_ms: gap,
            ..Liveness::default()
        }
    }

    #[test]
    fn a_wall_clock_jump_closes_every_session_and_restarts_the_relay() {
        let mut e = Engine::with_liveness(short(), ObPolicy::default(), live_gap(10_000));
        let sid = open(&mut e, 0);
        connect(&mut e, 0, &sid);
        let (held, done) = slot();
        e.handle(1, request("GET", &q(&sid), ""), done);
        assert!(taken(&held).is_none());
        // Normal turns, including a small wall-clock correction, change nothing.
        let wall = 1_700_000_000_000;
        assert!(!e.observe_clock(1_000, wall + 1_000));
        assert!(!e.observe_clock(2_000, wall + 2_000));
        assert!(!e.observe_clock(3_000, wall + 8_000));
        // The wall clock stepping backwards is not a resume either.
        assert!(!e.observe_clock(4_000, wall + 1_000));
        assert_eq!(e.session_count(), 1);
        // The machine slept for ten minutes: the monotonic clock advanced 1 s, the wall 601 s.
        assert!(e.observe_clock(5_000, wall + 602_000));
        assert_eq!(e.session_count(), 0);
        assert_eq!(taken(&held).unwrap().body, "1");
        // The old sid is unknown: the client reconnects at once.
        assert_eq!(
            call(&mut e, 5_001, "GET", &q(&sid), "").unwrap().status,
            400
        );
    }

    #[test]
    fn a_stalled_loop_counts_as_a_resume_even_when_both_clocks_advance() {
        let mut e = Engine::with_liveness(short(), ObPolicy::default(), live_gap(10_000));
        let sid = open(&mut e, 0);
        connect(&mut e, 0, &sid);
        let wall = 1_700_000_000_000;
        assert!(!e.observe_clock(0, wall));
        // A monotonic clock that counts sleep: both clocks jumped 5 minutes.
        assert!(e.observe_clock(300_000, wall + 300_000));
        assert_eq!(e.session_count(), 0);
        // The first observation after start never counts.
        let mut fresh = Engine::new(short());
        assert!(!fresh.observe_clock(10_000_000, 1));
    }

    #[test]
    fn a_resume_keeps_the_relay_for_the_reconnecting_ui() {
        let (mut e, _old) = engine_with_relay(1);
        let wall = 1_700_000_000_000;
        e.observe_clock(1_000, wall);
        assert!(e.observe_clock(2_000, wall + 3_600_000));
        let cmds = e.take_ob();
        assert!(matches!(cmds.as_slice(), [ObCmd::Resume]), "{cmds:?}");
        // The restarted client reports the loss and the recovery while the UI reconnects.
        e.ob_event(1, ObEvent::Disconnected);
        e.ob_event(1, ObEvent::Connected);
        let (_new, packets) = reconnect_session(&mut e, 2_100);
        assert_eq!(packets.last().unwrap(), r#"42["OB_SOCKET::connect",{}]"#);
        assert!(e.take_ob().is_empty());
    }

    #[test]
    fn a_resume_without_a_relay_asks_for_nothing() {
        let (mut e, _sid) = connected_engine();
        let wall = 1_700_000_000_000;
        e.observe_clock(0, wall);
        assert!(e.observe_clock(1_000, wall + 3_600_000));
        assert!(e.take_ob().is_empty());
    }

    #[test]
    fn a_probe_that_never_answers_is_abandoned() {
        let cfg = Config {
            probe_interval_ms: 1_000,
            ..Config::default()
        };
        let mut e = Engine::new(cfg);
        let sid = open(&mut e, 0);
        connect(&mut e, 0, &sid);
        assert_eq!(e.tick(0).probes, vec![sid.clone()]);
        // The probe is in flight: no second one, until it is declared lost.
        assert!(e.tick(PROBE_STUCK_MS).probes.is_empty());
        assert_eq!(e.tick(PROBE_STUCK_MS + 1).probes, vec![sid.clone()]);
        // A late answer for the abandoned probe is harmless.
        e.probe_result(
            &sid,
            Probe::Info {
                height: 5,
                headers: 5,
            },
        );
    }

    #[test]
    fn engine_collections_stay_bounded_across_many_reconnects() {
        let (mut e, _sid) = engine_with_relay(1);
        for n in 0..200u64 {
            let t = 10 + n;
            let (sid, _) = reconnect_session(&mut e, t);
            if n % 2 == 0 {
                emit(&mut e, t, &sid, "1");
            }
            assert!(e.session_count() <= MAX_SESSIONS);
            assert!(e.take_ob().len() <= MAX_OB_OUT);
        }
    }

    // ---- block events

    #[test]
    fn probes_run_only_while_the_namespace_is_connected_and_emit_new_blocks() {
        let mut e = Engine::new(short());
        let sid = open(&mut e, 0);
        assert!(e.tick(0).probes.is_empty());
        connect(&mut e, 0, &sid);
        let t = e.tick(0);
        assert_eq!(t.probes, vec![sid.clone()]);
        // In flight: no second probe until the result arrives.
        assert!(e.tick(20).probes.is_empty());
        e.probe_result(
            &sid,
            Probe::Info {
                height: 101,
                headers: 105,
            },
        );
        let out = call(&mut e, 21, "GET", &q(&sid), "").unwrap().body;
        assert_eq!(out, r#"42["new-block",{"height":101,"header":105}]"#);
        assert_eq!(e.tick(21).probes, vec![sid.clone()]);
        // Same height: nothing new. Higher: another event.
        e.probe_result(
            &sid,
            Probe::Info {
                height: 101,
                headers: 105,
            },
        );
        assert_eq!(e.sessions[0].queue.len(), 0);
        e.tick(40);
        e.probe_result(
            &sid,
            Probe::Info {
                height: 102,
                headers: 105,
            },
        );
        assert_eq!(e.sessions[0].queue.len(), 1);
    }

    #[test]
    fn new_block_releases_a_held_poll() {
        let mut e = Engine::new(short());
        let sid = open(&mut e, 0);
        connect(&mut e, 0, &sid);
        e.tick(0);
        let (held, done) = slot();
        e.handle(1, request("GET", &q(&sid), ""), done);
        e.probe_result(
            &sid,
            Probe::Info {
                height: 7,
                headers: 7,
            },
        );
        assert_eq!(
            taken(&held).unwrap().body,
            r#"42["new-block",{"height":7,"header":7}]"#
        );
    }

    #[test]
    fn core_error_is_sent_once_after_a_node_that_answered_goes_silent() {
        let mut e = Engine::new(short());
        let sid = open(&mut e, 0);
        connect(&mut e, 0, &sid);
        // Never connected: no core-error, whatever the node says.
        e.tick(0);
        e.probe_result(&sid, Probe::Error("boom".into()));
        e.probe_result(&sid, Probe::NotConnected);
        assert!(e.sessions[0].queue.is_empty());
        e.tick(20);
        e.probe_result(
            &sid,
            Probe::Info {
                height: 5,
                headers: 5,
            },
        );
        e.probe_result(&sid, Probe::Error("connect ECONNREFUSED".into()));
        e.probe_result(&sid, Probe::Error("connect ECONNREFUSED".into()));
        let out = call(&mut e, 30, "GET", &q(&sid), "").unwrap().body;
        let parts: Vec<&str> = out.split(SEP).collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[1], r#"42["core-error","connect ECONNREFUSED"]"#);
        // Recovery re-arms it.
        e.probe_result(
            &sid,
            Probe::Info {
                height: 6,
                headers: 6,
            },
        );
        e.probe_result(&sid, Probe::Error("down again".into()));
        assert_eq!(e.sessions[0].queue.len(), 2);
    }

    #[test]
    fn probe_results_for_gone_sessions_are_dropped() {
        let mut e = Engine::new(short());
        e.probe_result(
            "gone",
            Probe::Info {
                height: 1,
                headers: 1,
            },
        );
        assert_eq!(e.session_count(), 0);
    }

    // ---- the thread

    struct FakeNode(Arc<Mutex<Vec<Probe>>>);

    impl NodeProbe for FakeNode {
        fn probe(&self, done: Box<dyn FnOnce(Probe) + Send>) {
            let mut q = self.0.lock().unwrap();
            done(if q.is_empty() {
                Probe::NotConnected
            } else {
                q.remove(0)
            });
        }
    }

    fn serve(h: &Handle, method: &str, query: &str, body: &str) -> mpsc::Receiver<SioResponse> {
        let (tx, rx) = mpsc::channel();
        h.serve(
            request(method, query, body),
            Box::new(move |r| {
                let _ = tx.send(r);
            }),
        );
        rx
    }

    const WAIT: Duration = Duration::from_secs(5);

    #[test]
    fn the_thread_serves_a_full_client_session() {
        let script = Arc::new(Mutex::new(vec![Probe::Info {
            height: 9,
            headers: 10,
        }]));
        let h = start(Box::new(FakeNode(script)), short(), ObPolicy::default()).unwrap();
        let open = serve(&h, "GET", Q, "").recv_timeout(WAIT).unwrap();
        let v: Value = serde_json::from_str(&open.body[1..]).unwrap();
        let sid = v["sid"].as_str().unwrap().to_string();
        assert_eq!(
            serve(&h, "POST", &q(&sid), "40")
                .recv_timeout(WAIT)
                .unwrap()
                .body,
            "ok"
        );
        // The first poll carries the namespace reply (and perhaps the first block).
        let first = serve(&h, "GET", &q(&sid), "")
            .recv_timeout(WAIT)
            .unwrap()
            .body;
        assert!(first.starts_with("40{"));
        let mut seen = first;
        // Poll until the new-block event arrives; idle polls are answered with pings.
        for _ in 0..20 {
            if seen.contains("new-block") {
                break;
            }
            seen = serve(&h, "GET", &q(&sid), "")
                .recv_timeout(WAIT)
                .unwrap()
                .body;
        }
        assert!(
            seen.contains(r#"42["new-block",{"height":9,"header":10}]"#),
            "{seen}"
        );
        // An idle poll is answered with a ping after the (short) interval.
        let ping = serve(&h, "GET", &q(&sid), "")
            .recv_timeout(WAIT)
            .unwrap()
            .body;
        assert_eq!(ping, "2");
    }

    #[test]
    fn the_thread_answers_when_the_queue_is_full_or_stopped() {
        let (tx, rx) = mpsc::sync_channel::<Cmd>(1);
        let h = Handle { tx };
        let _a = serve(&h, "GET", Q, "");
        let busy = serve(&h, "GET", Q, "").recv_timeout(WAIT).unwrap();
        assert_eq!(busy.status, 503);
        drop(rx);
        let stopped = serve(&h, "GET", Q, "").recv_timeout(WAIT).unwrap();
        assert_eq!(stopped.status, 503);
    }
}
