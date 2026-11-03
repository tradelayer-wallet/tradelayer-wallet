//! Orderbook relay: the legacy wallet-server's `OBSocketService`, in Rust.
//!
//! The legacy UI asks its main socket to `ob-sockets-connect` to an orderbook server
//! (`tl-orderbook-server`, socket.io 4.x). The legacy Node server connected a socket.io client to
//! that URL and relayed events in both directions. This module is that client, over Engine.IO v4
//! **long polling** on blocking `reqwest` (no WebSocket, no extra crate), plus the pure mapping
//! between the two sockets. The socket.io server side lives in [`crate::socketio`], whose
//! [`Engine`](crate::socketio::Engine) decides *whether* to connect and queues commands
//! ([`ObCmd`]); a [`Manager`] on the `socketio` thread turns them into client threads, which hand
//! events back as [`ObEvent`]s.
//!
//! ## Relay semantics (from `ob-sockets.service.ts`)
//!
//! * `connect`, `disconnect`, `connect_error` of the client reach the UI as `OB_SOCKET::<name>`.
//! * After connect, server events `order:error`, `order:saved`, `placed-orders`, `orderbook-data`,
//!   `update-orders-request` and `new-channel` reach the UI as `OB_SOCKET::<name>` with their
//!   payload.
//! * UI events `update-orderbook`, `new-order`, `close-order` and `many-orders` go to the server
//!   unprefixed.
//! * Swap: the UI emits `<obSocketId>::swap` (the socket.io id the orderbook gave this client);
//!   it is forwarded under the same name. A `new-channel` payload `d` names the counterparty
//!   `cp = d.isBuyer ? d.tradeInfo.seller.socketId : d.tradeInfo.buyer.socketId`; the server's
//!   `<cp>::swap` events reach the UI unprefixed. A later `new-channel` replaces the registration.
//!
//! ## Repaired defects (the legacy server did none of these)
//!
//! * It connected to **any** URL the page named. Here the URL's origin must equal an entry of the
//!   `orderbook_urls` allowlist ([`ObPolicy`]); anything else is refused with
//!   `OB_SOCKET::connect_error` and no network I/O. URLs with a path (a path is a socket.io
//!   namespace), credentials, query or fragment are refused.
//! * It relayed any event name in either direction through unchecked listeners; here both
//!   directions use fixed name allowlists, the swap names are bound to valid socket ids and the
//!   client's own id, and everything else is dropped.
//! * Payloads were unbounded. Here a poll response is at most [`MAX_POLL_BYTES`], a UI payload at
//!   most [`MAX_UI_PAYLOAD`], a poll may carry at most [`MAX_PACKETS_PER_POLL`] packets and every
//!   queue is bounded.
//! * A malformed `new-channel` payload threw inside the handler; here the cp registration is
//!   simply left unchanged.
//! * Replaced clients were never joined; here at most [`MAX_LIVE_CLIENTS`] exist at once and a
//!   stopped client's late events are discarded by generation number.

use crate::legacy::{http_client_with, read_bounded};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// The orderbook servers `endpoints.conf.ts` ships (LTC, LTCTEST).
pub const DEFAULT_ORDERBOOK_URLS: [&str; 2] =
    ["http://172.81.181.19:9190", "http://172.81.181.19:8190"];
pub const MAX_ORDERBOOK_URLS: usize = 16;
const MAX_URL_LEN: usize = 2048;

/// Largest UI->server event payload, serialized.
pub const MAX_UI_PAYLOAD: usize = 64 * 1024;
/// Largest poll response body.
pub const MAX_POLL_BYTES: usize = 1 << 20;
/// Most packets one poll response may carry.
pub const MAX_PACKETS_PER_POLL: usize = 128;
const OUT_DEPTH: usize = 64;
/// Clients that may exist at once, counting stopped ones still blocked in a poll.
pub const MAX_LIVE_CLIENTS: usize = 3;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const SEP: char = '\x1e';
const MIN_PING: u64 = 50;
const MAX_PING: u64 = 300_000;
const DEFAULT_PING_INTERVAL: u64 = 25_000;
const DEFAULT_PING_TIMEOUT: u64 = 20_000;

pub const SERVER_EVENTS: [&str; 6] = [
    "order:error",
    "order:saved",
    "placed-orders",
    "orderbook-data",
    "update-orders-request",
    "new-channel",
];
pub const UI_EVENTS: [&str; 4] = [
    "update-orderbook",
    "new-order",
    "close-order",
    "many-orders",
];

// ------------------------------------------------------------------ allowlist

/// `scheme://host[:port]` of an orderbook URL, lowercased with the default port elided.
/// `http` and `https` only, with no credentials, path, query or fragment.
pub fn normalize_origin(s: &str) -> Result<String, String> {
    if s.len() > MAX_URL_LEN {
        return Err("orderbook URL is too long".into());
    }
    let u = reqwest::Url::parse(s).map_err(|_| "orderbook URL is malformed".to_string())?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err("orderbook URL must be http or https".into());
    }
    if u.host_str().is_none() {
        return Err("orderbook URL has no host".into());
    }
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("orderbook URL must not carry credentials, query or fragment".into());
    }
    if u.path() != "/" {
        return Err("orderbook URL must be an origin without a path".into());
    }
    Ok(u.origin().ascii_serialization())
}

/// Which orderbook origins the UI may connect to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObPolicy {
    origins: Vec<String>,
}

impl Default for ObPolicy {
    fn default() -> ObPolicy {
        ObPolicy {
            origins: DEFAULT_ORDERBOOK_URLS
                .iter()
                .map(|s| s.to_string())
                .collect(),
        }
    }
}

impl ObPolicy {
    /// Origins as already normalized by [`normalize_origin`]; others are ignored.
    pub fn new(origins: Vec<String>) -> ObPolicy {
        ObPolicy {
            origins: origins
                .iter()
                .filter_map(|o| normalize_origin(o).ok())
                .collect(),
        }
    }

    /// No origin allowed: the relay refuses everything.
    pub fn none() -> ObPolicy {
        ObPolicy {
            origins: Vec::new(),
        }
    }

    /// The URL the UI named, or the reason it is refused. No network I/O happens here.
    pub fn check(&self, url: &str) -> Result<reqwest::Url, String> {
        let origin = normalize_origin(url)?;
        if !self.origins.contains(&origin) {
            return Err("orderbook URL is not in orderbook_urls".into());
        }
        reqwest::Url::parse(&origin).map_err(|_| "orderbook URL is malformed".to_string())
    }
}

// ------------------------------------------------------------------ packets

/// A socket.io id: what the orderbook server's `socket.id` looks like, bounded.
pub fn valid_socket_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `42["name"]` or `42["name",payload]`, with the name and payload JSON-escaped.
pub fn encode_event(name: &str, payload: Option<&Value>) -> String {
    let mut v = vec![Value::String(name.to_string())];
    if let Some(p) = payload {
        v.push(p.clone());
    }
    format!("42{}", Value::Array(v))
}

/// What the orderbook server sent, as the client acts on it.
#[derive(Debug, PartialEq)]
pub enum ServerPacket {
    /// Engine.IO close (`1`).
    Close,
    /// Engine.IO ping (`2`).
    Ping,
    /// Engine.IO noop (`6`).
    Noop,
    /// socket.io CONNECT (`40{"sid":..}`).
    Connected(String),
    /// socket.io CONNECT_ERROR (`44{..}`) or an unusable CONNECT.
    ConnectError(String),
    /// socket.io DISCONNECT (`41`).
    Disconnect,
    /// socket.io EVENT (`42[name, payload]`); only the first argument is kept, as the relay did.
    Event(String, Option<Value>),
    /// Binary packets, other namespaces, unknown types and malformed packets.
    Ignored,
}

pub fn parse_server_packet(p: &str) -> ServerPacket {
    let mut chars = p.chars();
    match chars.next() {
        Some('1') => ServerPacket::Close,
        Some('2') if p == "2" => ServerPacket::Ping,
        Some('6') => ServerPacket::Noop,
        Some('4') => {
            let kind = chars.next();
            let rest = chars.as_str();
            if rest.starts_with('/') {
                return ServerPacket::Ignored;
            }
            match kind {
                Some('0') => match serde_json::from_str::<Value>(rest) {
                    Ok(v) => match v["sid"].as_str() {
                        Some(sid) if valid_socket_id(sid) => {
                            ServerPacket::Connected(sid.to_string())
                        }
                        _ => {
                            ServerPacket::ConnectError("orderbook sent no usable socket id".into())
                        }
                    },
                    Err(_) => {
                        ServerPacket::ConnectError("orderbook sent no usable socket id".into())
                    }
                },
                Some('1') => ServerPacket::Disconnect,
                Some('4') => ServerPacket::ConnectError("orderbook refused the connection".into()),
                Some('2') => {
                    let json = rest.trim_start_matches(|c: char| c.is_ascii_digit());
                    match serde_json::from_str::<Value>(json) {
                        Ok(Value::Array(mut a)) => match a.first() {
                            Some(Value::String(name)) => {
                                let name = name.clone();
                                let payload = if a.len() > 1 {
                                    Some(a.swap_remove(1))
                                } else {
                                    None
                                };
                                ServerPacket::Event(name, payload)
                            }
                            _ => ServerPacket::Ignored,
                        },
                        _ => ServerPacket::Ignored,
                    }
                }
                _ => ServerPacket::Ignored,
            }
        }
        _ => ServerPacket::Ignored,
    }
}

/// The Engine.IO open packet (`0{...}`). `maxPayload` is not required (socket.io 4.4 omits it).
#[derive(Debug, PartialEq, Eq)]
pub struct Open {
    pub sid: String,
    pub ping_interval: Duration,
    pub ping_timeout: Duration,
}

pub fn parse_open(body: &str) -> Result<Open, String> {
    let json = body
        .strip_prefix('0')
        .ok_or("orderbook did not answer with an Engine.IO open packet")?;
    let v: Value = serde_json::from_str(json).map_err(|_| "orderbook open packet is not JSON")?;
    let sid = v["sid"]
        .as_str()
        .filter(|s| valid_socket_id(s))
        .ok_or("orderbook open packet has no usable session id")?;
    let ms = |key: &str, default: u64| {
        Duration::from_millis(v[key].as_u64().unwrap_or(default).clamp(MIN_PING, MAX_PING))
    };
    Ok(Open {
        sid: sid.to_string(),
        ping_interval: ms("pingInterval", DEFAULT_PING_INTERVAL),
        ping_timeout: ms("pingTimeout", DEFAULT_PING_TIMEOUT),
    })
}

// ------------------------------------------------------------------ relay mapping

/// Syntactic check on a UI event name before it is queued for the client: a fixed name, or
/// `<valid socket id>::swap`.
pub fn outbound_name_ok(name: &str) -> bool {
    UI_EVENTS.contains(&name) || name.strip_suffix("::swap").is_some_and(valid_socket_id)
}

/// Payload bound for UI->server events.
pub fn ui_payload_ok(payload: Option<&Value>) -> bool {
    payload.is_none_or(|p| p.to_string().len() <= MAX_UI_PAYLOAD)
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// The counterparty socket id of a `new-channel` payload, if the payload is well-formed.
fn counterparty(d: &Value) -> Option<String> {
    let side = if truthy(&d["isBuyer"]) {
        "seller"
    } else {
        "buyer"
    };
    let id = d["tradeInfo"][side]["socketId"].as_str()?;
    valid_socket_id(id).then(|| id.to_string())
}

/// Per-connection mapping state: this client's socket id and the registered counterparty.
#[derive(Debug, Default)]
pub struct Relay {
    sid: Option<String>,
    cp: Option<String>,
}

impl Relay {
    pub fn set_sid(&mut self, sid: &str) {
        self.sid = Some(sid.to_string());
    }

    /// Map a server event to the event the UI receives, or `None` to drop it.
    pub fn map_server_event(
        &mut self,
        name: &str,
        payload: Option<Value>,
    ) -> Option<(String, Option<Value>)> {
        if SERVER_EVENTS.contains(&name) {
            if name == "new-channel" {
                if let Some(cp) = payload.as_ref().and_then(counterparty) {
                    self.cp = Some(cp);
                }
            }
            return Some((format!("OB_SOCKET::{name}"), payload));
        }
        let cp = self.cp.as_deref()?;
        (name.strip_suffix("::swap") == Some(cp)).then(|| (name.to_string(), payload))
    }

    /// Map a UI event to the packet sent to the server, or `None` to drop it.
    pub fn map_ui_event(&self, name: &str, payload: Option<&Value>) -> Option<String> {
        let swap = name.strip_suffix("::swap");
        let allowed = UI_EVENTS.contains(&name) || (swap.is_some() && swap == self.sid.as_deref());
        (allowed && ui_payload_ok(payload)).then(|| encode_event(name, payload))
    }
}

// ------------------------------------------------------------------ engine <-> client types

/// What the engine asks the [`Manager`] to do.
#[derive(Debug, PartialEq)]
pub enum ObCmd {
    /// Replace any client with a new one for `url` (already checked against the policy).
    Connect { gen: u64, url: reqwest::Url },
    /// Forward a UI event (already name- and size-checked) to the server.
    Send {
        name: String,
        payload: Option<Value>,
    },
    /// Close the client.
    Stop,
}

/// What a client reports back, tagged with its generation.
#[derive(Debug, PartialEq)]
pub enum ObEvent {
    Connected,
    ConnectError(String),
    Disconnected,
    /// An event already mapped for the UI (`OB_SOCKET::*` or `<cp>::swap`).
    Relay {
        name: String,
        payload: Option<Value>,
    },
}

/// Delivers a client's event to the engine; `false` means the engine is gone.
pub type Sink = Arc<dyn Fn(u64, ObEvent) -> bool + Send + Sync>;

enum Out {
    Event {
        name: String,
        payload: Option<Value>,
    },
    Pong,
    Close,
}

struct Shared {
    gen: u64,
    sink: Sink,
    relay: Mutex<Relay>,
    /// The engine stopped this client; it reports nothing further.
    stopped: AtomicBool,
    connected: AtomicBool,
    /// A terminal event was reported (or the engine is gone).
    finished: AtomicBool,
}

impl Shared {
    fn deliver(&self, ev: ObEvent) -> bool {
        if self.stopped.load(Ordering::SeqCst) {
            return false;
        }
        if (self.sink)(self.gen, ev) {
            true
        } else {
            self.finished.store(true, Ordering::SeqCst);
            false
        }
    }

    /// Report the end of the connection once: `disconnect` if it had connected, else
    /// `connect_error` with the reason.
    fn end(&self, reason: &str) {
        if self.stopped.load(Ordering::SeqCst) || self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        let ev = if self.connected.load(Ordering::SeqCst) {
            ObEvent::Disconnected
        } else {
            ObEvent::ConnectError(reason.to_string())
        };
        let _ = (self.sink)(self.gen, ev);
    }
}

struct LiveGuard(Arc<AtomicUsize>);

impl Drop for LiveGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct Running {
    shared: Arc<Shared>,
    tx: mpsc::SyncSender<Out>,
}

/// Owns the current client. Lives on the `socketio` thread.
pub struct Manager {
    sink: Sink,
    live: Arc<AtomicUsize>,
    current: Option<Running>,
}

impl Manager {
    pub fn new(sink: Sink) -> Manager {
        Manager {
            sink,
            live: Arc::new(AtomicUsize::new(0)),
            current: None,
        }
    }

    /// Carry out one command. An event the engine must see at once (a client that could not be
    /// started) is returned instead of being sent through the sink, so the engine thread never
    /// waits on its own queue.
    pub fn apply(&mut self, cmd: ObCmd) -> Option<(u64, ObEvent)> {
        match cmd {
            ObCmd::Stop => {
                self.stop();
                None
            }
            ObCmd::Send { name, payload } => {
                if let Some(r) = &self.current {
                    // A full queue drops the event: the client is not keeping up.
                    let _ = r.tx.try_send(Out::Event { name, payload });
                }
                None
            }
            ObCmd::Connect { gen, url } => {
                self.stop();
                if self.live.load(Ordering::SeqCst) >= MAX_LIVE_CLIENTS {
                    return Some((
                        gen,
                        ObEvent::ConnectError(
                            "earlier orderbook connections are still closing".into(),
                        ),
                    ));
                }
                let (tx, rx) = mpsc::sync_channel::<Out>(OUT_DEPTH);
                let shared = Arc::new(Shared {
                    gen,
                    sink: self.sink.clone(),
                    relay: Mutex::new(Relay::default()),
                    stopped: AtomicBool::new(false),
                    connected: AtomicBool::new(false),
                    finished: AtomicBool::new(false),
                });
                self.live.fetch_add(1, Ordering::SeqCst);
                let guard = LiveGuard(self.live.clone());
                let (s2, pong) = (shared.clone(), tx.clone());
                let spawned = std::thread::Builder::new()
                    .name("obrelay".into())
                    .spawn(move || {
                        let _guard = guard;
                        client_main(&s2, &url, rx, pong);
                    });
                match spawned {
                    Ok(_) => {
                        self.current = Some(Running { shared, tx });
                        None
                    }
                    Err(_) => Some((
                        gen,
                        ObEvent::ConnectError("could not start the orderbook client".into()),
                    )),
                }
            }
        }
    }

    fn stop(&mut self) {
        if let Some(r) = self.current.take() {
            r.shared.stopped.store(true, Ordering::SeqCst);
            let _ = r.tx.try_send(Out::Close);
        }
    }
}

impl Drop for Manager {
    fn drop(&mut self) {
        self.stop();
    }
}

// ------------------------------------------------------------------ the client

struct Transport {
    client: reqwest::blocking::Client,
    base: reqwest::Url,
}

impl Transport {
    fn url(&self, sid: Option<&str>) -> reqwest::Url {
        let mut u = self.base.clone();
        {
            let mut q = u.query_pairs_mut();
            q.append_pair("EIO", "4")
                .append_pair("transport", "polling");
            if let Some(s) = sid {
                q.append_pair("sid", s);
            }
        }
        u
    }

    fn get(&self, sid: Option<&str>, timeout: Duration) -> Result<String, String> {
        let resp = self
            .client
            .get(self.url(sid))
            .timeout(timeout)
            .send()
            .map_err(|e| format!("orderbook request failed: {}", e.without_url()))?;
        if resp.status().as_u16() != 200 {
            return Err(format!(
                "orderbook answered HTTP {}",
                resp.status().as_u16()
            ));
        }
        if resp
            .content_length()
            .is_some_and(|n| n > MAX_POLL_BYTES as u64)
        {
            return Err("orderbook response too large".into());
        }
        let bytes = read_bounded(resp, MAX_POLL_BYTES)?;
        String::from_utf8(bytes).map_err(|_| "orderbook response is not UTF-8".to_string())
    }

    fn post(&self, sid: &str, body: &str) -> Result<(), String> {
        let resp = self
            .client
            .post(self.url(Some(sid)))
            .header("Content-Type", "text/plain;charset=UTF-8")
            .timeout(REQUEST_TIMEOUT)
            .body(body.to_string())
            .send()
            .map_err(|e| format!("orderbook request failed: {}", e.without_url()))?;
        if resp.status().as_u16() != 200 {
            return Err(format!(
                "orderbook answered HTTP {}",
                resp.status().as_u16()
            ));
        }
        // The reply is `ok`; read a bounded amount so the connection ends cleanly.
        read_bounded(resp, 1024).map(|_| ())
    }
}

fn client_main(
    shared: &Arc<Shared>,
    url: &reqwest::Url,
    rx: mpsc::Receiver<Out>,
    pong: mpsc::SyncSender<Out>,
) {
    let tr = match http_client_with(url, CONNECT_TIMEOUT, REQUEST_TIMEOUT).and_then(|client| {
        url.join("socket.io/")
            .map(|base| Transport { client, base })
            .map_err(|_| "orderbook URL cannot carry a socket.io path".to_string())
    }) {
        Ok(t) => Arc::new(t),
        Err(e) => return shared.end(&e),
    };
    let open = match tr.get(None, REQUEST_TIMEOUT).and_then(|b| parse_open(&b)) {
        Ok(o) => o,
        Err(e) => return shared.end(&e),
    };
    if shared.stopped.load(Ordering::SeqCst) {
        let _ = tr.post(&open.sid, "1");
        return;
    }
    if let Err(e) = tr.post(&open.sid, "40") {
        return shared.end(&e);
    }
    let (tw, sw, sid) = (tr.clone(), shared.clone(), open.sid.clone());
    if std::thread::Builder::new()
        .name("obrelay-send".into())
        .spawn(move || writer(&tw, &sw, &sid, rx))
        .is_err()
    {
        return shared.end("could not start the orderbook client");
    }
    let started = Instant::now();
    let poll_timeout = open.ping_interval + open.ping_timeout;
    loop {
        if shared.stopped.load(Ordering::SeqCst) || shared.finished.load(Ordering::SeqCst) {
            return;
        }
        let body = match tr.get(Some(&open.sid), poll_timeout) {
            Ok(b) => b,
            Err(e) => return shared.end(&e),
        };
        if shared.stopped.load(Ordering::SeqCst) {
            return;
        }
        if !shared.connected.load(Ordering::SeqCst) && started.elapsed() > CONNECT_TIMEOUT {
            return shared.end("orderbook did not accept the connection in time");
        }
        for (n, raw) in body.split(SEP).enumerate() {
            if n >= MAX_PACKETS_PER_POLL {
                return shared.end("orderbook sent too many packets at once");
            }
            match parse_server_packet(raw) {
                ServerPacket::Ping => {
                    let _ = pong.try_send(Out::Pong);
                }
                ServerPacket::Noop | ServerPacket::Ignored => {}
                ServerPacket::Close => return shared.end("orderbook closed the session"),
                ServerPacket::Disconnect => return shared.end("orderbook disconnected"),
                ServerPacket::ConnectError(r) => return shared.end(&r),
                ServerPacket::Connected(id) => {
                    if !shared.connected.swap(true, Ordering::SeqCst) {
                        shared
                            .relay
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .set_sid(&id);
                        if !shared.deliver(ObEvent::Connected) {
                            return;
                        }
                    }
                }
                ServerPacket::Event(name, payload) => {
                    if !shared.connected.load(Ordering::SeqCst) {
                        continue;
                    }
                    let mapped = shared
                        .relay
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .map_server_event(&name, payload);
                    if let Some((name, payload)) = mapped {
                        if !shared.deliver(ObEvent::Relay { name, payload })
                            && shared.stopped.load(Ordering::SeqCst)
                        {
                            return;
                        }
                    }
                }
            }
        }
    }
}

fn writer(tr: &Transport, shared: &Shared, sid: &str, rx: mpsc::Receiver<Out>) {
    loop {
        match rx.recv() {
            Ok(Out::Pong) => {
                if let Err(e) = tr.post(sid, "3") {
                    return shared.end(&e);
                }
            }
            Ok(Out::Event { name, payload }) => {
                if !shared.connected.load(Ordering::SeqCst) {
                    continue;
                }
                let packet = shared
                    .relay
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .map_ui_event(&name, payload.as_ref());
                if let Some(p) = packet {
                    if let Err(e) = tr.post(sid, &p) {
                        return shared.end(&e);
                    }
                }
            }
            Ok(Out::Close) | Err(_) => break,
        }
    }
    if !shared.finished.load(Ordering::SeqCst) {
        // Socket.io DISCONNECT, then the Engine.IO close.
        let _ = tr.post(sid, &format!("41{SEP}1"));
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legacy::ALLOWED_ORIGIN;
    use crate::socketio::{self, Handle, NodeProbe, Probe, SioRequest};
    use serde_json::json;
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::sync::Condvar;

    // ---- pure pieces

    #[test]
    fn origins_are_normalized_and_strict() {
        assert_eq!(
            normalize_origin("http://172.81.181.19:9190").unwrap(),
            "http://172.81.181.19:9190"
        );
        assert_eq!(
            normalize_origin("HTTPS://OB.Example:443/").unwrap(),
            "https://ob.example"
        );
        for bad in [
            "",
            "ob.example",
            "ws://ob.example",
            "wss://ob.example",
            "file:///etc/passwd",
            "http://u:p@ob.example",
            "http://ob.example/ns",
            "http://ob.example/?a=1",
            "http://ob.example/#f",
            "http://",
        ] {
            assert!(normalize_origin(bad).is_err(), "{bad:?}");
        }
        assert!(
            normalize_origin(&format!("http://a.example/{}", "x".repeat(MAX_URL_LEN))).is_err()
        );
    }

    #[test]
    fn policy_accepts_listed_origins_only() {
        let p = ObPolicy::default();
        assert!(p.check("http://172.81.181.19:9190").is_ok());
        assert!(p.check("http://172.81.181.19:8190/").is_ok());
        for bad in [
            "http://172.81.181.19:9191",
            "https://172.81.181.19:9190",
            "http://127.0.0.1:9190",
            "http://localhost:9190",
            "http://169.254.169.254",
            "http://172.81.181.19:9190/admin",
        ] {
            assert!(p.check(bad).is_err(), "{bad:?}");
        }
        let custom = ObPolicy::new(vec!["http://127.0.0.1:18190".into(), "junk".into()]);
        assert!(custom.check("http://127.0.0.1:18190").is_ok());
        assert!(custom.check("http://172.81.181.19:9190").is_err());
        assert!(ObPolicy::none().check("http://172.81.181.19:9190").is_err());
    }

    #[test]
    fn socket_ids_are_bounded_and_simple() {
        assert!(valid_socket_id("AbC_-123"));
        assert!(valid_socket_id(&"a".repeat(64)));
        for bad in ["", "a b", "a:b", "a/b", "a\"b", "\u{e9}", &"a".repeat(65)] {
            assert!(!valid_socket_id(bad), "{bad:?}");
        }
        assert!(outbound_name_ok("new-order"));
        assert!(outbound_name_ok("abc123::swap"));
        for bad in [
            "",
            "::swap",
            "a b::swap",
            "order:saved",
            "swap",
            "x::swap::swap",
        ] {
            assert!(!outbound_name_ok(bad), "{bad:?}");
        }
    }

    #[test]
    fn events_are_encoded_with_json_escaping() {
        assert_eq!(encode_event("new-order", None), r#"42["new-order"]"#);
        let name = "a\"b\\c\nd\u{1f600}";
        let payload = json!({"k\"": "v\\\n\u{0}", "n": [1, 2.5, null]});
        let packet = encode_event(name, Some(&payload));
        assert!(!packet.contains('\n'));
        assert_eq!(
            parse_server_packet(&packet),
            ServerPacket::Event(name.to_string(), Some(payload))
        );
    }

    #[test]
    fn server_packets_are_parsed_and_junk_is_ignored() {
        use ServerPacket::*;
        assert_eq!(parse_server_packet("2"), Ping);
        assert_eq!(parse_server_packet("1"), Close);
        assert_eq!(parse_server_packet("6"), Noop);
        assert_eq!(
            parse_server_packet(r#"40{"sid":"Abc-1_"}"#),
            Connected("Abc-1_".into())
        );
        assert!(matches!(
            parse_server_packet(r#"40{"sid":"a b"}"#),
            ConnectError(_)
        ));
        assert!(matches!(parse_server_packet("40"), ConnectError(_)));
        assert!(matches!(
            parse_server_packet(r#"44{"message":"nope"}"#),
            ConnectError(_)
        ));
        assert_eq!(parse_server_packet("41"), Disconnect);
        assert_eq!(
            parse_server_packet(r#"42["orderbook-data",{"a":1},"extra"]"#),
            Event("orderbook-data".into(), Some(json!({"a": 1})))
        );
        assert_eq!(
            parse_server_packet(r#"4217["order:saved"]"#),
            Event("order:saved".into(), None)
        );
        for junk in [
            "",
            "4",
            "42",
            "42[",
            "42{}",
            "42[1]",
            "42[]",
            "42/ns,[\"a\"]",
            "40/ns,{}",
            r#"45-["a",{"_placeholder":true,"num":0}]"#,
            "46",
            "bAAEC",
            "3",
            "0{}",
            "2probe",
            "\u{1f600}",
            "4\u{1f600}",
        ] {
            assert_eq!(parse_server_packet(junk), Ignored, "{junk:?}");
        }
    }

    #[test]
    fn open_packet_needs_a_sid_but_not_maxpayload() {
        let o = parse_open(
            r#"0{"sid":"abc-1","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000}"#,
        )
        .unwrap();
        assert_eq!(o.sid, "abc-1");
        assert_eq!(o.ping_interval, Duration::from_secs(25));
        assert_eq!(o.ping_timeout, Duration::from_secs(20));
        let d = parse_open(r#"0{"sid":"abc"}"#).unwrap();
        assert_eq!(
            d.ping_interval,
            Duration::from_millis(DEFAULT_PING_INTERVAL)
        );
        let c = parse_open(r#"0{"sid":"abc","pingInterval":1,"pingTimeout":99999999999}"#).unwrap();
        assert_eq!(c.ping_interval, Duration::from_millis(MIN_PING));
        assert_eq!(c.ping_timeout, Duration::from_millis(MAX_PING));
        for bad in [
            "",
            "6",
            "1",
            "0",
            "0{",
            r#"0{"sid":"a b"}"#,
            r#"0{"sid":5}"#,
            "{\"sid\":\"a\"}",
        ] {
            assert!(parse_open(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn server_events_map_to_prefixed_ui_events() {
        let mut r = Relay::default();
        for e in SERVER_EVENTS {
            let (n, p) = r.map_server_event(e, Some(json!(1))).unwrap();
            assert_eq!(n, format!("OB_SOCKET::{e}"));
            assert_eq!(p, Some(json!(1)));
        }
        assert_eq!(
            r.map_server_event("order:saved", None),
            Some(("OB_SOCKET::order:saved".into(), None))
        );
        for e in [
            "connect",
            "disconnect",
            "__proto__",
            "update-orderbook",
            "OB_SOCKET::connect",
            "x::swap",
        ] {
            assert_eq!(r.map_server_event(e, Some(json!(1))), None, "{e}");
        }
    }

    #[test]
    fn new_channel_registers_the_counterparty_swap_event() {
        let mut r = Relay::default();
        let as_buyer = json!({"isBuyer": true, "tradeInfo": {"seller": {"socketId": "SELL1"}, "buyer": {"socketId": "BUY1"}}});
        let (n, p) = r
            .map_server_event("new-channel", Some(as_buyer.clone()))
            .unwrap();
        assert_eq!((n.as_str(), p), ("OB_SOCKET::new-channel", Some(as_buyer)));
        assert_eq!(
            r.map_server_event("SELL1::swap", Some(json!({"s": 1}))),
            Some(("SELL1::swap".into(), Some(json!({"s": 1}))))
        );
        assert_eq!(r.map_server_event("BUY1::swap", None), None);
        // Seller side, and a later channel replaces the registration.
        let as_seller = json!({"isBuyer": false, "tradeInfo": {"seller": {"socketId": "SELL2"}, "buyer": {"socketId": "BUY2"}}});
        r.map_server_event("new-channel", Some(as_seller));
        assert_eq!(r.map_server_event("SELL1::swap", None), None);
        assert!(r.map_server_event("BUY2::swap", None).is_some());
        // Malformed or hostile payloads leave the registration alone.
        for bad in [
            json!(null),
            json!("x"),
            json!({"isBuyer": true}),
            json!({"isBuyer": true, "tradeInfo": {"seller": {"socketId": "a b"}}}),
            json!({"isBuyer": true, "tradeInfo": {"seller": {"socketId": 7}}}),
            json!({"isBuyer": true, "tradeInfo": {"seller": {"socketId": "x\",\"y"}}}),
            json!({"isBuyer": true, "tradeInfo": {"seller": {"socketId": "a".repeat(65)}}}),
        ] {
            assert!(r.map_server_event("new-channel", Some(bad)).is_some());
            assert!(r.map_server_event("BUY2::swap", None).is_some());
        }
        // JS truthiness of isBuyer.
        let mut t = Relay::default();
        t.map_server_event(
            "new-channel",
            Some(json!({"isBuyer": 1, "tradeInfo": {"seller": {"socketId": "S"}, "buyer": {"socketId": "B"}}})),
        );
        assert!(t.map_server_event("S::swap", None).is_some());
        t.map_server_event(
            "new-channel",
            Some(json!({"tradeInfo": {"seller": {"socketId": "S"}, "buyer": {"socketId": "B"}}})),
        );
        assert!(t.map_server_event("B::swap", None).is_some());
    }

    #[test]
    fn ui_events_map_to_unprefixed_server_events() {
        let mut r = Relay::default();
        assert_eq!(
            r.map_ui_event("new-order", Some(&json!({"p": 1}))),
            Some(r#"42["new-order",{"p":1}]"#.into())
        );
        assert_eq!(
            r.map_ui_event("many-orders", None),
            Some(r#"42["many-orders"]"#.into())
        );
        for e in [
            "connect",
            "ob-sockets-connect",
            "OB_SOCKET::connect",
            "orderbook-data",
            "x",
        ] {
            assert_eq!(r.map_ui_event(e, None), None, "{e}");
        }
        // Swap only under this client's own socket id.
        assert_eq!(r.map_ui_event("MINE::swap", None), None);
        r.set_sid("MINE");
        assert!(r.map_ui_event("MINE::swap", Some(&json!(1))).is_some());
        assert_eq!(r.map_ui_event("OTHER::swap", None), None);
        assert_eq!(r.map_ui_event("::swap", None), None);
        // Payload bound.
        let big = Value::String("a".repeat(MAX_UI_PAYLOAD));
        assert_eq!(r.map_ui_event("new-order", Some(&big)), None);
        let fits = Value::String("a".repeat(MAX_UI_PAYLOAD - 2));
        assert!(r.map_ui_event("new-order", Some(&fits)).is_some());
    }

    // ---- mock socket.io polling server

    #[derive(Default)]
    struct MockState {
        outbound: VecDeque<String>,
        received: Vec<String>,
        connections: usize,
        closed: bool,
    }

    struct Mock {
        addr: SocketAddr,
        st: Arc<(Mutex<MockState>, Condvar)>,
        open: String,
    }

    const NS_SID: &str = "NsSid_1";

    fn http_reply(stream: &mut TcpStream, status: &str, body: &str) {
        let r = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(r.as_bytes());
    }

    fn read_request(stream: &mut TcpStream) -> Option<(String, String, String)> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        let head_end = loop {
            let n = stream.read(&mut chunk).ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break p + 4;
            }
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let len = head
            .lines()
            .find_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.eq_ignore_ascii_case("content-length")
                    .then(|| v.trim().parse::<usize>().ok())?
            })
            .unwrap_or(0);
        while buf.len() < head_end + len {
            let n = stream.read(&mut chunk).ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        let body = String::from_utf8_lossy(&buf[head_end..head_end + len]).to_string();
        let mut first = head.lines().next()?.split(' ');
        Some((first.next()?.to_string(), first.next()?.to_string(), body))
    }

    impl Mock {
        fn start() -> Mock {
            Mock::start_with_open(
                r#"0{"sid":"EioSid1","upgrades":["websocket"],"pingInterval":300,"pingTimeout":200}"#,
            )
        }

        fn start_with_open(open: &str) -> Mock {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let st: Arc<(Mutex<MockState>, Condvar)> = Arc::default();
            let st2 = st.clone();
            let open_s = open.to_string();
            let open_t = open_s.clone();
            std::thread::spawn(move || {
                for conn in listener.incoming() {
                    let Ok(mut stream) = conn else { continue };
                    let st = st2.clone();
                    let open = open_t.clone();
                    st.0.lock().unwrap().connections += 1;
                    std::thread::spawn(move || {
                        let Some((method, target, body)) = read_request(&mut stream) else {
                            return;
                        };
                        assert!(target.starts_with("/socket.io/?"), "{target}");
                        assert!(target.contains("EIO=4") && target.contains("transport=polling"));
                        let has_sid = target.contains("sid=EioSid1");
                        let (lock, cv) = &*st;
                        match (method.as_str(), has_sid) {
                            ("GET", false) => http_reply(&mut stream, "200 OK", &open),
                            ("POST", true) => {
                                let mut s = lock.lock().unwrap();
                                for p in body.split(SEP) {
                                    if p == "40" {
                                        s.outbound.push_back(format!(r#"40{{"sid":"{NS_SID}"}}"#));
                                    }
                                    s.received.push(p.to_string());
                                }
                                cv.notify_all();
                                drop(s);
                                http_reply(&mut stream, "200 OK", "ok");
                            }
                            ("GET", true) => {
                                let mut s = lock.lock().unwrap();
                                let deadline = Instant::now() + Duration::from_secs(3);
                                while s.outbound.is_empty() && !s.closed {
                                    let left = deadline.saturating_duration_since(Instant::now());
                                    if left.is_zero() {
                                        break;
                                    }
                                    s = cv.wait_timeout(s, left).unwrap().0;
                                }
                                let out: Vec<String> = s.outbound.drain(..).collect();
                                let closed = s.closed;
                                drop(s);
                                let body = if !out.is_empty() {
                                    out.join(&SEP.to_string())
                                } else if closed {
                                    "1".to_string()
                                } else {
                                    "6".to_string()
                                };
                                http_reply(&mut stream, "200 OK", &body);
                            }
                            _ => http_reply(&mut stream, "400 Bad Request", "{}"),
                        }
                    });
                }
            });
            Mock {
                addr,
                st,
                open: open_s,
            }
        }

        fn url(&self) -> String {
            format!("http://{}", self.addr)
        }

        fn send(&self, packet: &str) {
            self.st
                .0
                .lock()
                .unwrap()
                .outbound
                .push_back(packet.to_string());
            self.st.1.notify_all();
        }

        fn received(&self) -> Vec<String> {
            self.st.0.lock().unwrap().received.clone()
        }

        fn connections(&self) -> usize {
            self.st.0.lock().unwrap().connections
        }

        fn wait_received(&self, what: &str, pred: impl Fn(&str) -> bool) -> String {
            let end = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(p) = self.received().into_iter().find(|p| pred(p)) {
                    return p;
                }
                assert!(
                    Instant::now() < end,
                    "mock never received {what}: {:?}",
                    self.received()
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }

    // ---- the UI side, driving the socketio thread

    struct FakeNode;

    impl NodeProbe for FakeNode {
        fn probe(&self, done: Box<dyn FnOnce(Probe) + Send>) {
            done(Probe::NotConnected);
        }
    }

    fn fast() -> socketio::Config {
        socketio::Config {
            ping_interval_ms: 100,
            ping_timeout_ms: 5_000,
            probe_interval_ms: 1_000,
        }
    }

    const Q: &str = "EIO=4&transport=polling";
    const WAIT: Duration = Duration::from_secs(10);

    struct Ui {
        h: Handle,
        sid: String,
        seen: Vec<String>,
    }

    impl Ui {
        fn call(h: &Handle, method: &str, query: &str, body: &str) -> socketio::SioResponse {
            let (tx, rx) = mpsc::channel();
            h.serve(
                SioRequest {
                    method: method.into(),
                    query: query.into(),
                    body: body.as_bytes().to_vec(),
                    origin: Some(ALLOWED_ORIGIN.into()),
                },
                Box::new(move |r| {
                    let _ = tx.send(r);
                }),
            );
            rx.recv_timeout(WAIT).unwrap()
        }

        fn connect(policy: ObPolicy) -> Ui {
            let h = socketio::start(Box::new(FakeNode), fast(), policy).unwrap();
            let open = Ui::call(&h, "GET", Q, "");
            let v: Value = serde_json::from_str(&open.body[1..]).unwrap();
            let sid = v["sid"].as_str().unwrap().to_string();
            let mut ui = Ui {
                h,
                sid,
                seen: Vec::new(),
            };
            assert_eq!(ui.post("40"), "ok");
            ui.wait_for("40{");
            ui
        }

        fn post(&self, body: &str) -> String {
            Ui::call(&self.h, "POST", &format!("{Q}&sid={}", self.sid), body).body
        }

        fn emit(&self, packet: &str) {
            assert_eq!(self.post(packet), "ok");
        }

        /// Poll until a packet containing `needle` arrives; returns that packet.
        fn wait_for(&mut self, needle: &str) -> String {
            let end = Instant::now() + WAIT;
            loop {
                if let Some(i) = self.seen.iter().position(|p| p.contains(needle)) {
                    return self.seen.remove(i);
                }
                assert!(
                    Instant::now() < end,
                    "UI never saw {needle}: {:?}",
                    self.seen
                );
                let r = Ui::call(&self.h, "GET", &format!("{Q}&sid={}", self.sid), "");
                assert_eq!(r.status, 200, "{}", r.body);
                for p in r.body.split(SEP) {
                    if p != "2" {
                        self.seen.push(p.to_string());
                    }
                }
            }
        }

        /// Poll for `ms` and fail if a packet containing `needle` shows up.
        fn assert_absent(&mut self, needle: &str, ms: u64) {
            let end = Instant::now() + Duration::from_millis(ms);
            while Instant::now() < end {
                let r = Ui::call(&self.h, "GET", &format!("{Q}&sid={}", self.sid), "");
                for p in r.body.split(SEP) {
                    assert!(!p.contains(needle), "unexpected {p}");
                    if p != "2" {
                        self.seen.push(p.to_string());
                    }
                }
            }
        }
    }

    fn policy_for(m: &Mock) -> ObPolicy {
        ObPolicy::new(vec![m.url()])
    }

    fn connect_packet(url: &str) -> String {
        encode_event("ob-sockets-connect", Some(&Value::String(url.into())))
    }

    #[test]
    fn end_to_end_connect_relay_forward_ping_and_server_disconnect() {
        let m = Mock::start();
        let mut ui = Ui::connect(policy_for(&m));
        ui.emit(&connect_packet(&m.url()));
        assert_eq!(
            ui.wait_for("OB_SOCKET::connect"),
            r#"42["OB_SOCKET::connect"]"#
        );
        assert_eq!(m.wait_received("namespace connect", |p| p == "40"), "40");

        // Server -> UI, prefixed, payload intact.
        m.send(r#"42["orderbook-data",{"orders":[{"price":"1.5","note":"a\"b"}],"history":[]}]"#);
        let got = ui.wait_for("OB_SOCKET::orderbook-data");
        assert_eq!(
            parse_server_packet(&got),
            ServerPacket::Event(
                "OB_SOCKET::orderbook-data".into(),
                Some(json!({"orders":[{"price":"1.5","note":"a\"b"}],"history":[]}))
            )
        );
        // Events outside the allowlist are dropped.
        m.send(r#"42["evil",1]"#);
        m.send(r#"42["order:saved","uuid-1"]"#);
        assert_eq!(
            ui.wait_for("OB_SOCKET::order:saved"),
            r#"42["OB_SOCKET::order:saved","uuid-1"]"#
        );
        assert!(ui.seen.iter().all(|p| !p.contains("evil")));

        // UI -> server, unprefixed.
        ui.emit(r#"42["new-order",{"price":1.5,"note":"x\"y"}]"#);
        let sent = m.wait_received("new-order", |p| p.contains("new-order"));
        assert_eq!(
            parse_server_packet(&sent),
            ServerPacket::Event("new-order".into(), Some(json!({"price":1.5,"note":"x\"y"})))
        );
        ui.emit(r#"42["not-allowed",1]"#);
        ui.emit(r#"42["update-orderbook",{"first":1}]"#);
        m.wait_received("update-orderbook", |p| p.contains("update-orderbook"));
        assert!(m.received().iter().all(|p| !p.contains("not-allowed")));

        // Engine.IO ping is answered with a pong.
        m.send("2");
        m.wait_received("pong", |p| p == "3");

        // The server drops the namespace.
        m.send("41");
        assert_eq!(
            ui.wait_for("OB_SOCKET::disconnect"),
            r#"42["OB_SOCKET::disconnect"]"#
        );
    }

    #[test]
    fn end_to_end_swap_events_follow_the_new_channel_counterparty() {
        let m = Mock::start();
        let mut ui = Ui::connect(policy_for(&m));
        ui.emit(&connect_packet(&m.url()));
        ui.wait_for("OB_SOCKET::connect");
        m.send(r#"42["CpSock::swap",{"early":1}]"#);
        m.send(r#"42["new-channel",{"isBuyer":true,"tradeInfo":{"seller":{"socketId":"CpSock"},"buyer":{"socketId":"NsSid_1"}}}]"#);
        ui.wait_for("OB_SOCKET::new-channel");
        m.send(r#"42["CpSock::swap",{"step":"propose"}]"#);
        assert_eq!(
            ui.wait_for("CpSock::swap"),
            r#"42["CpSock::swap",{"step":"propose"}]"#
        );
        m.send(r#"42["Stranger::swap",{"x":1}]"#);

        // The UI's own swap channel is forwarded; another socket's name is not.
        ui.emit(&format!(r#"42["{NS_SID}::swap",{{"step":"reply"}}]"#));
        ui.emit(r#"42["Stranger::swap",{"x":2}]"#);
        let sent = m.wait_received("own swap", |p| {
            p.starts_with(&format!(r#"42["{NS_SID}::swap""#))
        });
        assert!(sent.contains("reply"));
        // A marker event after the dropped one proves it was not forwarded.
        ui.emit(r#"42["close-order","u1"]"#);
        m.wait_received("marker", |p| p.contains("close-order"));
        assert!(m.received().iter().all(|p| !p.contains("Stranger")));
        assert!(ui.seen.iter().all(|p| !p.contains("Stranger")));
    }

    #[test]
    fn end_to_end_refused_url_makes_no_connection() {
        let m = Mock::start();
        // The mock's origin is not in the allowlist.
        let mut ui = Ui::connect(ObPolicy::default());
        ui.emit(&connect_packet(&m.url()));
        let got = ui.wait_for("OB_SOCKET::connect_error");
        assert_eq!(
            got,
            r#"42["OB_SOCKET::connect_error","orderbook URL is not in orderbook_urls"]"#
        );
        for bad in [
            format!("{}/ns", m.url()),
            format!("ws://{}", m.addr),
            "http://u:p@127.0.0.1:1".to_string(),
        ] {
            ui.emit(&connect_packet(&bad));
            ui.wait_for("OB_SOCKET::connect_error");
        }
        ui.emit(r#"42["ob-sockets-connect",5]"#);
        ui.wait_for("OB_SOCKET::connect_error");
        ui.emit(r#"42["ob-sockets-connect"]"#);
        ui.wait_for("OB_SOCKET::connect_error");
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(m.connections(), 0);
    }

    #[test]
    fn end_to_end_ui_disconnect_closes_the_client() {
        let m = Mock::start();
        let mut ui = Ui::connect(policy_for(&m));
        ui.emit(&connect_packet(&m.url()));
        ui.wait_for("OB_SOCKET::connect");
        ui.emit(r#"42["ob-sockets-disconnect"]"#);
        assert_eq!(
            ui.wait_for("OB_SOCKET::disconnect"),
            r#"42["OB_SOCKET::disconnect"]"#
        );
        m.wait_received("socket.io disconnect", |p| p == "41");
        m.wait_received("engine close", |p| p == "1");
        // Nothing is relayed any more.
        m.send(r#"42["order:saved","late"]"#);
        ui.assert_absent("late", 400);
    }

    #[test]
    fn end_to_end_closing_the_ui_session_stops_the_client() {
        let m = Mock::start();
        let mut ui = Ui::connect(policy_for(&m));
        ui.emit(&connect_packet(&m.url()));
        ui.wait_for("OB_SOCKET::connect");
        // The UI's Engine.IO close packet ends its session.
        ui.emit("1");
        m.wait_received("socket.io disconnect", |p| p == "41");
    }

    #[test]
    fn end_to_end_a_new_connect_replaces_the_client() {
        let m1 = Mock::start();
        let m2 = Mock::start();
        let mut ui = Ui::connect(ObPolicy::new(vec![m1.url(), m2.url()]));
        ui.emit(&connect_packet(&m1.url()));
        ui.wait_for("OB_SOCKET::connect");
        ui.emit(&connect_packet(&m2.url()));
        ui.wait_for("OB_SOCKET::connect");
        m1.wait_received("old client closed", |p| p == "41");
        m2.send(r#"42["order:saved","from-two"]"#);
        ui.wait_for("from-two");
        // The old server's events no longer reach the UI.
        m1.send(r#"42["order:saved","from-one"]"#);
        ui.assert_absent("from-one", 400);
    }

    #[test]
    fn end_to_end_server_refusal_and_dead_server_are_connect_errors() {
        let m = Mock::start();
        let mut ui = Ui::connect(policy_for(&m));
        ui.emit(&connect_packet(&m.url()));
        m.wait_received("namespace connect", |p| p == "40");
        // The namespace connect is answered before ours (`40` queued by the mock); a CONNECT_ERROR
        // from a second connection attempt is what a rejecting server sends.
        ui.wait_for("OB_SOCKET::connect");
        ui.emit(r#"42["ob-sockets-disconnect"]"#);
        ui.wait_for("OB_SOCKET::disconnect");

        let bad = Mock::start_with_open("0{\"sid\":\"bad sid\"}");
        let mut ui2 = Ui::connect(policy_for(&bad));
        ui2.emit(&connect_packet(&bad.url()));
        let got = ui2.wait_for("OB_SOCKET::connect_error");
        assert!(got.contains("session id"), "{got}");
        assert!(!bad.open.is_empty());

        // Nothing listens: the connection is refused.
        let dead = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", dead.local_addr().unwrap());
        drop(dead);
        let mut ui3 = Ui::connect(ObPolicy::new(vec![url.clone()]));
        ui3.emit(&connect_packet(&url));
        let got = ui3.wait_for("OB_SOCKET::connect_error");
        assert!(got.contains("orderbook request failed"), "{got}");
        assert!(!got.contains("127.0.0.1"), "{got}");
    }

    /// Against a real orderbook server: `TL_OB_URL=http://127.0.0.1:18190` (the legacy
    /// `tl-orderbook-server`). Run with `cargo test --locked -- --ignored real_orderbook`.
    #[test]
    #[ignore = "needs a running tl-orderbook-server; set TL_OB_URL"]
    fn real_orderbook_server_round_trip() {
        let url = std::env::var("TL_OB_URL").expect("TL_OB_URL");
        let mut ui = Ui::connect(ObPolicy::new(vec![url.clone()]));
        ui.emit(&connect_packet(&url));
        assert_eq!(
            ui.wait_for("OB_SOCKET::connect"),
            r#"42["OB_SOCKET::connect"]"#
        );
        ui.emit(r#"42["update-orderbook",{"firstToken":1,"secondToken":2,"type":"SPOT"}]"#);
        let got = ui.wait_for("OB_SOCKET::orderbook-data");
        match parse_server_packet(&got) {
            ServerPacket::Event(name, Some(p)) => {
                assert_eq!(name, "OB_SOCKET::orderbook-data");
                assert!(p["orders"].is_array() && p["history"].is_array(), "{p}");
            }
            other => panic!("unexpected {other:?}"),
        }
        ui.emit(r#"42["ob-sockets-disconnect"]"#);
        ui.wait_for("OB_SOCKET::disconnect");
    }
}
