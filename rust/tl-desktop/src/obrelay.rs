//! Orderbook relay: FE-speed's `OBSocketService` (`ob-sockets.service.ts`), in Rust.
//!
//! The UI asks its main socket to `ob-sockets-connect` to an orderbook server (the HyperExpress /
//! uWebSockets `tl-orderbook-server`, branch `auth`): a raw WebSocket at `ws://host:3001/ws`
//! carrying JSON text messages. The Node wallet-server connected a `ws` client to that URL and
//! relayed messages in both directions between it and the UI's socket.io main socket. This module
//! is that client, over a blocking [`tungstenite`] WebSocket (rustls for `wss://`) on its own
//! threads, plus the pure mapping between the two sockets. The socket.io server side lives in
//! [`crate::socketio`], whose [`Engine`](crate::socketio::Engine) decides *whether* to connect and
//! queues commands ([`ObCmd`]); a [`Manager`] on the `socketio` thread turns them into client
//! threads, which hand events back as [`ObEvent`]s.
//!
//! ## Wire format and relay mapping (from `ob-sockets.service.ts` and `manager_class.ts`)
//!
//! Server -> UI. Every message is a JSON object with a string `event`:
//!
//! | server message | UI event | payload |
//! |---|---|---|
//! | open | `OB_SOCKET::connect` | `{}` (the Node service sent none and the UI reads `data.id`) |
//! | `connected` (hello `{id, clientClass, authRequired}`) | `OB_SOCKET::connected` | the whole message |
//! | `order:error`, `order:saved`, `placed-orders`, `orderbook-data`, `update-orders-request`, `amended`, `auth_ok`, `auth_ignored` | `OB_SOCKET::<event>` | the whole message (flat) |
//! | `new-channel` `{data: {tradeInfo, unfilled, isBuyer}}` | `OB_SOCKET::new-channel` | `msg.data`, else the message |
//! | `<counterparty>::swap` `{data: SwapEvent}` | `<counterparty>::swap` | `msg.data` |
//! | close, error | `OB_SOCKET::disconnect` / `OB_SOCKET::connect_error` | none / reason |
//!
//! UI -> server. The payload is spread flat next to the event name, as `emitToServer` does
//! (`JSON.stringify({event, ...payload})`):
//!
//! | UI event | server message |
//! |---|---|
//! | `update-orderbook`, `new-order`, `close-order`, `many-orders`, `orderbook:join`, `orderbook:leave`, `amend-order`, `auth` | `{event, ...payload}` (an array payload of `many-orders` becomes `orders`) |
//! | `OB_SOCKET::new-channel` | `{event: "new-channel", ...payload}` |
//! | `<own id>::swap` `SwapEvent` | `{event: "<own id>::swap", eventName, socketId, data}` |
//!
//! A `new-channel` payload `d` names the counterparty
//! `cp = d.isBuyer ? d.tradeInfo.seller.socketId : d.tradeInfo.buyer.socketId`; only
//! `<cp>::swap` messages reach the UI. A later `new-channel` replaces the registration.
//!
//! ## Reconnect (the Node service reconnected only after an error; ours is explicit)
//!
//! * The first attempt that fails ends the client with `connect_error`. Once connected, the
//!   client never gives up: after a loss (server restart, network blip, a server `close`, silence
//!   past [`LinkTiming::dead_ms`]) it reconnects with a capped exponential backoff and jitter
//!   ([`Backoff`], [`Reconnect`]), also after a clean close, and reports `Connected` again.
//! * `Disconnected` is reported once per loss, not per attempt.
//! * UI events are forwarded only while connected and the queue is cleared on every connect:
//!   nothing is resent after a reconnect and the queue is bounded while the server is away.
//! * Every connection starts with a fresh [`Relay`] mapping (socket id, counterparty).
//! * A WebSocket ping goes out every [`LinkTiming::ping_ms`]; any frame from the server counts as
//!   life. A server that stays silent for [`LinkTiming::dead_ms`] is presumed gone (a half-open
//!   TCP connection after sleep or a cable pull) and the connection is replaced.
//! * [`ObCmd::Resume`] (the machine woke from sleep) replaces the client at once.
//!
//! ## Authentication
//!
//! The server's hello says `authRequired: true` for a `web` class client. Its `desktop` and `bot`
//! classes come from upgrade headers that the server does not read yet (`handleOpen(ws)` gets no
//! request), so this client sends none and relies on nothing but the hello. The `auth` event is
//! relayed so a session token can be presented, but the server's `/auth` routes do not build, so
//! there is nothing to obtain one from. Reads (`update-orderbook`, `orderbook:join`) work; a
//! mutation (`new-order`, `many-orders`, `amend-order`, `close-order`) gets the server's own
//! `order:error` ("Authentication required (web client)...") relayed to the UI as
//! `OB_SOCKET::order:error`.
//!
//! ## Repaired defects (the Node service did none of these)
//!
//! * It connected to **any** URL the page named. Here the URL's origin must equal an entry of the
//!   `orderbook_urls` allowlist ([`ObPolicy`]); anything else is refused with
//!   `OB_SOCKET::connect_error` and no network I/O. URLs with credentials, a query or a fragment
//!   are refused, and the path must be `/` or `/ws`.
//! * It relayed every server event and (through `onAny`) every `*::swap` name; here both
//!   directions use fixed name allowlists, the swap names are bound to valid socket ids and the
//!   client's own id, and everything else is dropped.
//! * A page payload with an `event` key overwrote the event name (`{event, ...payload}`); here the
//!   name always wins.
//! * Payloads were unbounded. Here a server message is at most [`MAX_WS_MESSAGE`], a UI payload at
//!   most [`MAX_UI_PAYLOAD`] and every queue is bounded.
//! * `emitToServer` sent on a closed socket and threw; here events are forwarded only while the
//!   connection is up.
//! * The 15 s heartbeat timer was never cleared; here the ping lives and dies with the connection.
//! * Replaced clients were never joined; here at most [`MAX_LIVE_CLIENTS`] exist at once and a
//!   stopped client's late events are discarded by generation number.

use serde_json::{Map, Value};
use std::collections::VecDeque;
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{HandshakeError, Message, WebSocket};

/// The orderbook server `endpoints.conf.ts` of FE-speed ships (LTC, LTCTEST and BTC alike).
pub const DEFAULT_ORDERBOOK_URLS: [&str; 1] = ["ws://172.81.181.19:3001"];
pub const MAX_ORDERBOOK_URLS: usize = 16;
const MAX_URL_LEN: usize = 2048;

/// Largest UI->server event payload, serialized.
pub const MAX_UI_PAYLOAD: usize = 64 * 1024;
/// Largest server->UI WebSocket message (text).
pub const MAX_WS_MESSAGE: usize = 1 << 20;
/// Packets queued for the server per client.
const OUT_DEPTH: usize = 64;
/// Clients that may exist at once, counting stopped ones still closing.
pub const MAX_LIVE_CLIENTS: usize = 3;
/// TCP connect plus TLS plus HTTP upgrade (`connectTimeoutMs` of the Node service).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a read waits before the loop looks at the outbox and the clock again.
const READ_SLICE: Duration = Duration::from_millis(20);
/// A connection that stayed up this long counts as working: the backoff starts over.
const STABLE_AFTER: Duration = Duration::from_secs(2);
/// How long a goodbye (a Close frame) waits for the server's answer.
const CLOSE_WAIT: Duration = Duration::from_millis(500);

/// Events the server may send; each reaches the UI as `OB_SOCKET::<name>` (map 4.3 of the
/// FE-speed porting notes). `::swap` names are handled separately.
pub const SERVER_EVENTS: [&str; 10] = [
    "connected",
    "order:error",
    "order:saved",
    "placed-orders",
    "orderbook-data",
    "update-orders-request",
    "new-channel",
    "amended",
    "auth_ok",
    "auth_ignored",
];
/// Events the UI may send; each goes to the server unprefixed.
pub const UI_EVENTS: [&str; 8] = [
    "update-orderbook",
    "new-order",
    "close-order",
    "many-orders",
    "orderbook:join",
    "orderbook:leave",
    "amend-order",
    "auth",
];
/// The UI's name for the channel announcement it passes on (`new-channel` on the wire).
const UI_NEW_CHANNEL: &str = "OB_SOCKET::new-channel";

// ------------------------------------------------------------------ allowlist

/// `ws`/`wss` scheme, lowercase host and port of an orderbook URL, with the default port elided.
/// `http`/`https` are accepted as the same scheme (`ws`/`wss`); anything else is refused, as is a
/// URL with credentials, a query or a fragment.
fn parse_target(s: &str, allow_ws_path: bool) -> Result<(String, reqwest::Url), String> {
    if s.len() > MAX_URL_LEN {
        return Err("orderbook URL is too long".into());
    }
    let u = reqwest::Url::parse(s).map_err(|_| "orderbook URL is malformed".to_string())?;
    let scheme = match u.scheme() {
        "ws" | "http" => "ws",
        "wss" | "https" => "wss",
        _ => return Err("orderbook URL must be ws, wss, http or https".into()),
    };
    let Some(host) = u.host_str() else {
        return Err("orderbook URL has no host".into());
    };
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("orderbook URL must not carry credentials, query or fragment".into());
    }
    let path_ok = u.path() == "/" || (allow_ws_path && u.path() == "/ws");
    if !path_ok {
        return Err(if allow_ws_path {
            "orderbook URL path must be / or /ws".into()
        } else {
            "orderbook URL must be an origin without a path".into()
        });
    }
    let origin = match u.port() {
        Some(p) => format!("{scheme}://{}:{p}", host.to_ascii_lowercase()),
        None => format!("{scheme}://{}", host.to_ascii_lowercase()),
    };
    let url = reqwest::Url::parse(&format!("{origin}{}", u.path()))
        .map_err(|_| "orderbook URL is malformed".to_string())?;
    Ok((origin, url))
}

/// `scheme://host[:port]` of an orderbook origin as the allowlist keeps it: `ws` or `wss`
/// (`http`/`https` spellings accepted), no credentials, path, query or fragment.
pub fn normalize_origin(s: &str) -> Result<String, String> {
    parse_target(s, false).map(|(origin, _)| origin)
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

    /// The URL the UI named (a `ws://` or `wss://` URL), or the reason it is refused. No network
    /// I/O happens here.
    pub fn check(&self, url: &str) -> Result<reqwest::Url, String> {
        let (origin, url) = parse_target(url.trim(), true)?;
        if !self.origins.contains(&origin) {
            return Err("orderbook URL is not in orderbook_urls".into());
        }
        Ok(url)
    }
}

// ------------------------------------------------------------------ socket.io packet codec
//
// The UI's main socket speaks socket.io (Engine.IO v4 long polling, served by `crate::socketio`).
// These are the packets of *that* socket; the orderbook link below is plain WebSocket JSON.

/// A socket.io id: what the orderbook server's `connected.id` looks like, bounded.
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

/// The packet that tells the UI the orderbook link is up: `OB_SOCKET::connect` with an empty
/// object (the UI's handler reads `data.id`; the hello that follows carries the id).
pub fn connect_packet() -> String {
    encode_event("OB_SOCKET::connect", Some(&Value::Object(Map::new())))
}

/// A packet of the UI's socket.io connection, as the engine acts on it.
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
                        _ => ServerPacket::ConnectError("no usable socket id".into()),
                    },
                    Err(_) => ServerPacket::ConnectError("no usable socket id".into()),
                },
                Some('1') => ServerPacket::Disconnect,
                Some('4') => ServerPacket::ConnectError("connection refused".into()),
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

// ------------------------------------------------------------------ relay mapping

/// Syntactic check on a UI event name before it is queued for the client: a fixed name, or
/// `<valid socket id>::swap`.
pub fn outbound_name_ok(name: &str) -> bool {
    UI_EVENTS.contains(&name)
        || name == UI_NEW_CHANNEL
        || name.strip_suffix("::swap").is_some_and(valid_socket_id)
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

/// The JSON text for the server: `{event, ...payload}` with the event name winning over a
/// payload key of the same name. A non-object payload contributes nothing, except the array of
/// `many-orders` (what the UI sends when it has no `network` to add), which becomes `orders`.
fn flat_message(wire_event: &str, payload: Option<&Value>) -> String {
    let mut m = Map::new();
    m.insert("event".into(), Value::String(wire_event.to_string()));
    match payload {
        Some(Value::Object(o)) => {
            for (k, v) in o {
                if k != "event" {
                    m.insert(k.clone(), v.clone());
                }
            }
        }
        Some(Value::Array(a)) if wire_event == "many-orders" => {
            m.insert("orders".into(), Value::Array(a.clone()));
        }
        _ => {}
    }
    Value::Object(m).to_string()
}

/// The swap message of `ob-sockets.service.ts`: only `eventName`, `socketId` and `data` travel.
fn swap_message(wire_event: &str, payload: Option<&Value>) -> String {
    let mut m = Map::new();
    m.insert("event".into(), Value::String(wire_event.to_string()));
    if let Some(Value::Object(o)) = payload {
        for k in ["eventName", "socketId", "data"] {
            if let Some(v) = o.get(k) {
                m.insert(k.into(), v.clone());
            }
        }
    }
    Value::Object(m).to_string()
}

/// Per-connection mapping state: this client's socket id and the registered counterparty.
#[derive(Debug, Default)]
pub struct Relay {
    sid: Option<String>,
    cp: Option<String>,
}

impl Relay {
    #[cfg(test)]
    pub fn set_sid(&mut self, sid: &str) {
        self.sid = Some(sid.to_string());
    }

    /// Map a server message to the event the UI receives, or `None` to drop it. A message is a
    /// JSON object with a string `event`; anything else is dropped.
    pub fn map_server_message(&mut self, msg: Value) -> Option<(String, Option<Value>)> {
        let name = msg.get("event")?.as_str()?.to_string();
        if name.contains("::swap") {
            // `<cp>::swap`: the payload is `msg.data`, and only the registered counterparty's
            // name is relayed.
            let cp = self.cp.as_deref()?;
            if name.strip_suffix("::swap") != Some(cp) {
                return None;
            }
            let data = msg.get("data").cloned();
            return Some((name, data));
        }
        match name.as_str() {
            "connected" => {
                if let Some(id) = msg["id"].as_str().filter(|id| valid_socket_id(id)) {
                    self.sid = Some(id.to_string());
                }
                Some(("OB_SOCKET::connected".into(), Some(msg)))
            }
            "new-channel" => {
                let d = match msg.get("data") {
                    Some(d) if truthy(d) => d.clone(),
                    _ => msg,
                };
                if let Some(cp) = counterparty(&d) {
                    self.cp = Some(cp);
                }
                Some(("OB_SOCKET::new-channel".into(), Some(d)))
            }
            n if SERVER_EVENTS.contains(&n) => Some((format!("OB_SOCKET::{n}"), Some(msg))),
            _ => None,
        }
    }

    /// Map a UI event to the JSON text sent to the server, or `None` to drop it.
    pub fn map_ui_event(&self, name: &str, payload: Option<&Value>) -> Option<String> {
        if !ui_payload_ok(payload) {
            return None;
        }
        if UI_EVENTS.contains(&name) {
            return Some(flat_message(name, payload));
        }
        if name == UI_NEW_CHANNEL {
            return Some(flat_message("new-channel", payload));
        }
        let own = name.strip_suffix("::swap")?;
        (self.sid.as_deref() == Some(own)).then(|| swap_message(name, payload))
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
    /// The machine was suspended: the client's connection cannot be trusted. Restart it now
    /// instead of waiting for the silence timeout.
    Resume,
}

/// What a client reports back, tagged with its generation.
#[derive(Debug, PartialEq)]
pub enum ObEvent {
    /// The WebSocket is open (the first time, and again after every reconnect).
    Connected,
    /// The first connection attempt failed; the client has ended.
    ConnectError(String),
    /// The connection was lost, reported once per loss; the client keeps reconnecting.
    Disconnected,
    /// An event already mapped for the UI (`OB_SOCKET::*` or `<cp>::swap`).
    Relay {
        name: String,
        payload: Option<Value>,
    },
}

/// Delivers a client's event to the engine; `false` means the engine is gone.
pub type Sink = Arc<dyn Fn(u64, ObEvent) -> bool + Send + Sync>;

// ------------------------------------------------------------------ reconnect backoff

/// Bounds of the reconnect backoff, in milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reconnect {
    pub base_ms: u64,
    pub cap_ms: u64,
}

impl Default for Reconnect {
    fn default() -> Reconnect {
        Reconnect {
            base_ms: 500,
            cap_ms: 10_000,
        }
    }
}

/// How the client watches its connection, in milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkTiming {
    /// A WebSocket ping goes out this often (the Node service sent `{event:"ping"}` every 15 s).
    pub ping_ms: u64,
    /// No frame from the server for this long: the connection is presumed dead.
    pub dead_ms: u64,
}

impl Default for LinkTiming {
    fn default() -> LinkTiming {
        LinkTiming {
            ping_ms: 15_000,
            dead_ms: 45_000,
        }
    }
}

/// Capped exponential backoff with jitter: attempt `n` waits between half of and the whole of
/// `min(cap, base * 2^n)`. The jitter is an argument (`0.0..=1.0`) so the schedule is testable.
#[derive(Debug)]
pub struct Backoff {
    cfg: Reconnect,
    attempt: u32,
}

impl Backoff {
    pub fn new(cfg: Reconnect) -> Backoff {
        Backoff { cfg, attempt: 0 }
    }

    /// A connection worked: the next failure starts from the base delay again.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    pub fn next_delay_ms(&mut self, jitter: f64) -> u64 {
        let exp = self
            .cfg
            .base_ms
            .saturating_mul(1u64 << self.attempt.min(30))
            .min(self.cfg.cap_ms);
        self.attempt = self.attempt.saturating_add(1);
        let half = exp / 2;
        let j = if jitter.is_nan() {
            1.0
        } else {
            jitter.clamp(0.0, 1.0)
        };
        half + ((exp - half) as f64 * j) as u64
    }
}

fn random_unit() -> f64 {
    let mut b = [0u8; 8];
    match getrandom::fill(&mut b) {
        Ok(()) => (u64::from_le_bytes(b) >> 11) as f64 / (1u64 << 53) as f64,
        Err(_) => 1.0,
    }
}

// ------------------------------------------------------------------ shared client state

/// Events for the server, bounded; dropped while the client is not connected so that nothing
/// stale is sent after a reconnect.
struct Outbox {
    q: Mutex<VecDeque<(String, Option<Value>)>>,
}

impl Outbox {
    fn new() -> Outbox {
        Outbox {
            q: Mutex::new(VecDeque::new()),
        }
    }

    /// Queue an event; a full queue drops it (the client is not keeping up).
    fn push(&self, name: String, payload: Option<Value>) {
        let mut q = self.q.lock().unwrap_or_else(PoisonError::into_inner);
        if q.len() < OUT_DEPTH {
            q.push_back((name, payload));
        }
    }

    fn clear(&self) {
        self.q
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    fn pop(&self) -> Option<(String, Option<Value>)> {
        self.q
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.q.lock().unwrap_or_else(PoisonError::into_inner).len()
    }
}

struct Shared {
    gen: u64,
    sink: Sink,
    relay: Mutex<Relay>,
    outbox: Outbox,
    reconnect: Reconnect,
    timing: LinkTiming,
    /// The engine stopped this client; it reports nothing further.
    stopped: AtomicBool,
    /// Stopped without a goodbye: the connection is presumed dead.
    quiet: AtomicBool,
    /// The WebSocket is open right now.
    up: AtomicBool,
    /// The WebSocket has been open at least once.
    ever_up: AtomicBool,
    /// The client is over: its first attempt failed, or the engine is gone.
    finished: AtomicBool,
}

impl Shared {
    fn new(gen: u64, sink: Sink, reconnect: Reconnect, timing: LinkTiming) -> Shared {
        Shared {
            gen,
            sink,
            relay: Mutex::new(Relay::default()),
            outbox: Outbox::new(),
            reconnect,
            timing,
            stopped: AtomicBool::new(false),
            quiet: AtomicBool::new(false),
            up: AtomicBool::new(false),
            ever_up: AtomicBool::new(false),
            finished: AtomicBool::new(false),
        }
    }

    fn done(&self) -> bool {
        self.stopped.load(Ordering::SeqCst) || self.finished.load(Ordering::SeqCst)
    }

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

    /// The connection is gone: report `Disconnected` once per loss (a no-op when it was not up).
    fn lost(&self) {
        if self.up.swap(false, Ordering::SeqCst) {
            self.deliver(ObEvent::Disconnected);
        }
    }

    /// The first attempt failed for good.
    fn failed_initially(&self, reason: String) {
        if !self.finished.swap(true, Ordering::SeqCst) {
            let _ = self.deliver(ObEvent::ConnectError(reason));
        }
    }

    fn stop(&self, quiet: bool) {
        self.quiet.store(quiet, Ordering::SeqCst);
        self.stopped.store(true, Ordering::SeqCst);
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
    url: reqwest::Url,
}

/// Owns the current client. Lives on the `socketio` thread.
pub struct Manager {
    sink: Sink,
    reconnect: Reconnect,
    timing: LinkTiming,
    live: Arc<AtomicUsize>,
    current: Option<Running>,
}

impl Manager {
    pub fn new(sink: Sink, reconnect: Reconnect) -> Manager {
        Manager::with_timing(sink, reconnect, LinkTiming::default())
    }

    pub fn with_timing(sink: Sink, reconnect: Reconnect, timing: LinkTiming) -> Manager {
        Manager {
            sink,
            reconnect,
            timing,
            live: Arc::new(AtomicUsize::new(0)),
            current: None,
        }
    }

    fn new_shared(&self, gen: u64) -> Arc<Shared> {
        Arc::new(Shared::new(
            gen,
            self.sink.clone(),
            self.reconnect,
            self.timing,
        ))
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
                    // Only a connected client forwards: an event for a connection that is gone
                    // would be stale by the time the next one is up.
                    if r.shared.up.load(Ordering::SeqCst) {
                        r.shared.outbox.push(name, payload);
                    }
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
                let shared = self.new_shared(gen);
                self.start_client(shared, url)
            }
            ObCmd::Resume => {
                let r = self.current.as_ref()?;
                // The old client may sit on a connection that will only time out; it is stopped
                // without a goodbye and a new one takes over. If too many are still closing,
                // the old one stays and finds out by itself.
                if self.live.load(Ordering::SeqCst) >= MAX_LIVE_CLIENTS {
                    return None;
                }
                let (gen, url) = (r.shared.gen, r.url.clone());
                let shared = self.new_shared(gen);
                shared
                    .up
                    .store(r.shared.up.load(Ordering::SeqCst), Ordering::SeqCst);
                shared
                    .ever_up
                    .store(r.shared.ever_up.load(Ordering::SeqCst), Ordering::SeqCst);
                r.shared.stop(true);
                self.current = None;
                self.start_client(shared, url)
            }
        }
    }

    fn start_client(&mut self, shared: Arc<Shared>, url: reqwest::Url) -> Option<(u64, ObEvent)> {
        let gen = shared.gen;
        self.live.fetch_add(1, Ordering::SeqCst);
        let guard = LiveGuard(self.live.clone());
        let (s2, u2) = (shared.clone(), url.clone());
        let spawned = std::thread::Builder::new()
            .name("obrelay".into())
            .spawn(move || {
                let _guard = guard;
                supervisor(&s2, &u2);
            });
        match spawned {
            Ok(_) => {
                self.current = Some(Running { shared, url });
                None
            }
            Err(_) => Some((
                gen,
                ObEvent::ConnectError("could not start the orderbook client".into()),
            )),
        }
    }

    fn stop(&mut self) {
        if let Some(r) = self.current.take() {
            r.shared.stop(false);
        }
    }
}

impl Drop for Manager {
    fn drop(&mut self) {
        self.stop();
    }
}

// ------------------------------------------------------------------ the client

type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

/// How one connection ended.
struct Ended {
    reason: String,
    /// The connection stayed up long enough to count as working.
    stable: bool,
}

/// Sleep `ms`, in slices, until the client is stopped or finished.
fn sleep_unless_done(shared: &Shared, ms: u64) {
    let end = Instant::now() + Duration::from_millis(ms);
    while !shared.done() {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        std::thread::sleep(left.min(Duration::from_millis(50)));
    }
}

/// The client's life: connect, relay, and after a loss reconnect with backoff until stopped.
/// The first attempt that fails ends it with `ConnectError` (the UI asked for a server that is
/// not there); once connected it never gives up. `Disconnected` is reported once per loss.
fn supervisor(shared: &Arc<Shared>, url: &reqwest::Url) {
    // A restarted client (resume) that was connected tells the UI about the loss first.
    shared.lost();
    let mut backoff = Backoff::new(shared.reconnect);
    loop {
        if shared.done() {
            return;
        }
        let ended = match connect_and_relay(shared, url) {
            Ok(()) => return,
            Err(e) => e,
        };
        shared.lost();
        if shared.done() {
            return;
        }
        if !shared.ever_up.load(Ordering::SeqCst) {
            return shared.failed_initially(ended.reason);
        }
        if ended.stable {
            backoff.reset();
        }
        sleep_unless_done(shared, backoff.next_delay_ms(random_unit()));
    }
}

fn ws_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_WS_MESSAGE))
        .max_frame_size(Some(MAX_WS_MESSAGE))
        .accept_unmasked_frames(false)
}

fn io_message(e: &std::io::Error) -> &'static str {
    match e.kind() {
        std::io::ErrorKind::ConnectionRefused => "connection refused",
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => "timed out",
        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted => {
            "connection reset"
        }
        std::io::ErrorKind::UnexpectedEof => "connection closed",
        _ => "network error",
    }
}

/// A WebSocket error as a message that names no address.
fn ws_error_message(e: &tungstenite::Error) -> String {
    use tungstenite::Error as E;
    match e {
        E::ConnectionClosed | E::AlreadyClosed => "orderbook closed the connection".into(),
        E::Io(io) => format!("orderbook connection failed: {}", io_message(io)),
        E::Tls(_) => "orderbook TLS failure".into(),
        E::Capacity(_) => "orderbook message too large".into(),
        E::Http(resp) => format!("orderbook answered HTTP {}", resp.status().as_u16()),
        E::Protocol(_) | E::Utf8(_) | E::HttpFormat(_) => "orderbook broke the protocol".into(),
        _ => "orderbook connection failed".into(),
    }
}

/// The TCP stream under the WebSocket, for timeouts.
fn tcp_of(ws: &mut Ws) -> Option<&mut TcpStream> {
    match ws.get_mut() {
        MaybeTlsStream::Plain(s) => Some(s),
        MaybeTlsStream::Rustls(s) => Some(s.get_mut()),
        _ => None,
    }
}

fn resolve(url: &reqwest::Url) -> Result<Vec<SocketAddr>, String> {
    let port = url
        .port_or_known_default()
        .ok_or("orderbook URL has no port")?;
    let host = url.host_str().ok_or("orderbook URL has no host")?;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if bare.eq_ignore_ascii_case("localhost") {
        return Ok(vec![SocketAddr::from(([127, 0, 0, 1], port))]);
    }
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    (bare, port)
        .to_socket_addrs()
        .map(|a| a.collect())
        .map_err(|_| "orderbook host did not resolve".to_string())
}

/// TCP connect, TLS for `wss`, HTTP upgrade. The request carries no custom headers.
fn dial(url: &reqwest::Url) -> Result<Ws, String> {
    let mut stream = None;
    let mut last = "orderbook connection failed: network error".to_string();
    for addr in resolve(url)? {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(e) => last = format!("orderbook connection failed: {}", io_message(&e)),
        }
    }
    let stream = stream.ok_or(last)?;
    stream
        .set_nodelay(true)
        .and_then(|()| stream.set_read_timeout(Some(CONNECT_TIMEOUT)))
        .and_then(|()| stream.set_write_timeout(Some(WRITE_TIMEOUT)))
        .map_err(|_| "orderbook connection failed: network error".to_string())?;
    let request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "orderbook URL is malformed".to_string())?;
    let (mut ws, _resp) =
        tungstenite::client_tls_with_config(request, stream, Some(ws_config()), None).map_err(
            |e| match e {
                HandshakeError::Failure(e) => ws_error_message(&e),
                HandshakeError::Interrupted(_) => {
                    "orderbook connection failed: timed out".to_string()
                }
            },
        )?;
    if let Some(tcp) = tcp_of(&mut ws) {
        tcp.set_read_timeout(Some(READ_SLICE))
            .map_err(|_| "orderbook connection failed: network error".to_string())?;
    }
    Ok(ws)
}

/// Say goodbye (a Close frame) and wait briefly for the server's answer.
fn close_politely(ws: &mut Ws) {
    if ws.close(None).is_err() {
        return;
    }
    let end = Instant::now() + CLOSE_WAIT;
    while Instant::now() < end {
        match ws.read() {
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return,
        }
    }
}

/// One connection. `Ok` when the client was stopped (or the engine is gone), `Err` when the
/// connection ended.
fn connect_and_relay(shared: &Arc<Shared>, url: &reqwest::Url) -> Result<(), Ended> {
    let fail = |reason: String| Ended {
        reason,
        stable: false,
    };
    let mut ws = dial(url).map_err(fail)?;
    if shared.done() {
        if !shared.quiet.load(Ordering::SeqCst) {
            close_politely(&mut ws);
        }
        return Ok(());
    }
    *shared.relay.lock().unwrap_or_else(PoisonError::into_inner) = Relay::default();
    shared.outbox.clear();
    shared.up.store(true, Ordering::SeqCst);
    shared.ever_up.store(true, Ordering::SeqCst);
    if !shared.deliver(ObEvent::Connected) {
        return Ok(());
    }
    let started = Instant::now();
    let out = relay_loop(shared, &mut ws);
    let stable = started.elapsed() >= STABLE_AFTER;
    out.map_err(|reason| Ended { reason, stable })
}

fn relay_loop(shared: &Arc<Shared>, ws: &mut Ws) -> Result<(), String> {
    let timing = shared.timing;
    let (ping_every, dead_after) = (
        Duration::from_millis(timing.ping_ms.max(1)),
        Duration::from_millis(timing.dead_ms.max(1)),
    );
    let mut last_rx = Instant::now();
    let mut last_ping = Instant::now();
    loop {
        if shared.done() {
            if shared.stopped.load(Ordering::SeqCst) && !shared.quiet.load(Ordering::SeqCst) {
                close_politely(ws);
            }
            return Ok(());
        }
        // UI -> server.
        while let Some((name, payload)) = shared.outbox.pop() {
            let text = shared
                .relay
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .map_ui_event(&name, payload.as_ref());
            if let Some(text) = text {
                ws.send(Message::text(text))
                    .map_err(|e| ws_error_message(&e))?;
            }
        }
        if last_ping.elapsed() >= ping_every {
            last_ping = Instant::now();
            ws.send(Message::Ping(Vec::new().into()))
                .map_err(|e| ws_error_message(&e))?;
        }
        if last_rx.elapsed() >= dead_after {
            return Err("orderbook stopped answering".into());
        }
        // Server -> UI.
        match ws.read() {
            Ok(Message::Text(t)) => {
                last_rx = Instant::now();
                if !on_text(shared, t.as_str()) {
                    return Ok(());
                }
            }
            Ok(Message::Close(_)) => return Err("orderbook closed the connection".into()),
            Ok(_) => last_rx = Instant::now(),
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => return Err(ws_error_message(&e)),
        }
    }
}

/// One server text message. `false` when the engine is gone and the client should end.
fn on_text(shared: &Arc<Shared>, text: &str) -> bool {
    let Ok(msg) = serde_json::from_str::<Value>(text) else {
        return true;
    };
    let mapped = shared
        .relay
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .map_server_message(msg);
    match mapped {
        Some((name, payload)) => shared.deliver(ObEvent::Relay { name, payload }) || !shared.done(),
        None => true,
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legacy::ALLOWED_ORIGIN;
    use crate::socketio::{self, Handle, NodeProbe, Probe, SioRequest};
    use serde_json::json;
    use std::net::TcpListener;
    use std::sync::{mpsc, Condvar};

    const SEP: char = '\x1e';

    // ---- pure pieces

    #[test]
    fn origins_are_normalized_and_strict() {
        assert_eq!(
            normalize_origin("ws://172.81.181.19:3001").unwrap(),
            "ws://172.81.181.19:3001"
        );
        // http/https spellings are the same origin as ws/wss; default ports are elided.
        assert_eq!(
            normalize_origin("http://172.81.181.19:3001").unwrap(),
            "ws://172.81.181.19:3001"
        );
        assert_eq!(
            normalize_origin("HTTPS://OB.Example:443/").unwrap(),
            "wss://ob.example"
        );
        assert_eq!(
            normalize_origin("WS://OB.example:80").unwrap(),
            "ws://ob.example"
        );
        assert_eq!(
            normalize_origin("wss://ob.example:8443").unwrap(),
            "wss://ob.example:8443"
        );
        assert_eq!(
            normalize_origin("ws://[::1]:3001").unwrap(),
            "ws://[::1]:3001"
        );
        for bad in [
            "",
            "ob.example",
            "ftp://ob.example",
            "file:///etc/passwd",
            "http://u:p@ob.example",
            "ws://ob.example/ws",
            "ws://ob.example/ns",
            "ws://ob.example/?a=1",
            "ws://ob.example/#f",
            "ws://",
        ] {
            assert!(normalize_origin(bad).is_err(), "{bad:?}");
        }
        assert!(normalize_origin(&format!("ws://a.example/{}", "x".repeat(MAX_URL_LEN))).is_err());
    }

    #[test]
    fn policy_accepts_listed_origins_with_a_root_or_ws_path_only() {
        let p = ObPolicy::default();
        assert_eq!(
            p.check("ws://172.81.181.19:3001/ws").unwrap().as_str(),
            "ws://172.81.181.19:3001/ws"
        );
        assert_eq!(
            p.check(" ws://172.81.181.19:3001 ").unwrap().as_str(),
            "ws://172.81.181.19:3001/"
        );
        assert!(p.check("http://172.81.181.19:3001/ws").is_ok());
        for bad in [
            "ws://172.81.181.19:3002/ws",
            "wss://172.81.181.19:3001/ws",
            "ws://127.0.0.1:3001/ws",
            "ws://localhost:3001/ws",
            "ws://169.254.169.254/ws",
            "ws://172.81.181.19:3001/admin",
            "ws://172.81.181.19:3001/ws/x",
            "ws://172.81.181.19:3001/ws?token=1",
            "ws://u:p@172.81.181.19:3001/ws",
            "ftp://172.81.181.19:3001/ws",
        ] {
            assert!(p.check(bad).is_err(), "{bad:?}");
        }
        let custom = ObPolicy::new(vec!["ws://127.0.0.1:18190".into(), "junk".into()]);
        assert!(custom.check("ws://127.0.0.1:18190/ws").is_ok());
        assert!(custom.check("ws://172.81.181.19:3001/ws").is_err());
        assert!(ObPolicy::none()
            .check("ws://172.81.181.19:3001/ws")
            .is_err());
    }

    #[test]
    fn socket_ids_are_bounded_and_simple() {
        assert!(valid_socket_id("AbC_-123"));
        assert!(valid_socket_id("1762253481234-ab12cd3"));
        assert!(valid_socket_id(&"a".repeat(64)));
        for bad in ["", "a b", "a:b", "a/b", "a\"b", "\u{e9}", &"a".repeat(65)] {
            assert!(!valid_socket_id(bad), "{bad:?}");
        }
        assert!(outbound_name_ok("new-order"));
        assert!(outbound_name_ok("orderbook:join"));
        assert!(outbound_name_ok("orderbook:leave"));
        assert!(outbound_name_ok("amend-order"));
        assert!(outbound_name_ok("auth"));
        assert!(outbound_name_ok("OB_SOCKET::new-channel"));
        assert!(outbound_name_ok("abc123::swap"));
        for bad in [
            "",
            "::swap",
            "a b::swap",
            "order:saved",
            "swap",
            "x::swap::swap",
            "disconnect",
            "ping",
            "connected",
            "new-channel",
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
    fn ui_socket_packets_are_parsed_and_junk_is_ignored() {
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

    fn hello(id: &str) -> Value {
        json!({"event": "connected", "id": id, "clientClass": "web", "authRequired": true})
    }

    #[test]
    fn server_messages_map_to_prefixed_ui_events_with_the_whole_message() {
        let mut r = Relay::default();
        for e in SERVER_EVENTS.iter().filter(|e| **e != "new-channel") {
            let msg = json!({"event": e, "x": 1, "nested": {"data": 2}});
            let (n, p) = r.map_server_message(msg.clone()).unwrap();
            assert_eq!(n, format!("OB_SOCKET::{e}"));
            assert_eq!(p, Some(msg));
        }
        // The hello records the client's socket id.
        let (n, p) = r.map_server_message(hello("Me-1")).unwrap();
        assert_eq!(
            (n.as_str(), p),
            ("OB_SOCKET::connected", Some(hello("Me-1")))
        );
        assert!(r.map_ui_event("Me-1::swap", None).is_some());
        for bad in [
            json!({"event": "connect"}),
            json!({"event": "disconnect"}),
            json!({"event": "__proto__"}),
            json!({"event": "update-orderbook"}),
            json!({"event": "OB_SOCKET::connect"}),
            json!({"event": "x::swap", "data": 1}),
            json!({"event": 5}),
            json!({"event": null}),
            json!({"event": ["order:saved"]}),
            json!({"noevent": 1}),
            json!("order:saved"),
            json!([1, 2]),
            json!(null),
        ] {
            assert_eq!(r.map_server_message(bad.clone()), None, "{bad}");
        }
        // A hello with an unusable id is relayed but binds no swap name.
        let mut r2 = Relay::default();
        assert!(r2.map_server_message(hello("a b")).is_some());
        assert_eq!(r2.map_ui_event("a b::swap", None), None);
    }

    #[test]
    fn new_channel_registers_the_counterparty_and_unwraps_data() {
        let mut r = Relay::default();
        let d = json!({"isBuyer": true, "tradeInfo": {"seller": {"socketId": "SELL1"}, "buyer": {"socketId": "BUY1"}}, "unfilled": 0});
        // The server nests the channel under `data`; the UI gets `msg.data`.
        let (n, p) = r
            .map_server_message(json!({"event": "new-channel", "data": d.clone()}))
            .unwrap();
        assert_eq!((n.as_str(), p), ("OB_SOCKET::new-channel", Some(d)));
        // `<cp>::swap`: the payload is `msg.data`.
        let swap = json!({"eventName": "SELLER:STEP1", "socketId": "SELL1", "data": {"k": 1}});
        assert_eq!(
            r.map_server_message(json!({"event": "SELL1::swap", "data": swap.clone()})),
            Some(("SELL1::swap".into(), Some(swap)))
        );
        // No `data`: the event is relayed without payload.
        assert_eq!(
            r.map_server_message(json!({"event": "SELL1::swap"})),
            Some(("SELL1::swap".into(), None))
        );
        assert_eq!(
            r.map_server_message(json!({"event": "BUY1::swap", "data": 1})),
            None
        );
        // Flat form (no `data`): the whole message is the channel, as `msg.data || msg` does.
        let flat = json!({"event": "new-channel", "isBuyer": false, "tradeInfo": {"seller": {"socketId": "SELL2"}, "buyer": {"socketId": "BUY2"}}});
        let (_, p) = r.map_server_message(flat.clone()).unwrap();
        assert_eq!(p, Some(flat));
        assert_eq!(r.map_server_message(json!({"event": "SELL1::swap"})), None);
        assert!(r
            .map_server_message(json!({"event": "BUY2::swap", "data": 7}))
            .is_some());
        // Malformed or hostile payloads leave the registration alone.
        for bad in [
            json!({"event": "new-channel", "data": "x"}),
            json!({"event": "new-channel", "data": {"isBuyer": true}}),
            json!({"event": "new-channel", "data": {"isBuyer": true, "tradeInfo": {"seller": {"socketId": "a b"}}}}),
            json!({"event": "new-channel", "data": {"isBuyer": true, "tradeInfo": {"seller": {"socketId": 7}}}}),
            json!({"event": "new-channel", "data": {"isBuyer": true, "tradeInfo": {"seller": {"socketId": "x\",\"y"}}}}),
            json!({"event": "new-channel", "data": {"isBuyer": true, "tradeInfo": {"seller": {"socketId": "a".repeat(65)}}}}),
            json!({"event": "new-channel"}),
        ] {
            assert!(r.map_server_message(bad).is_some());
            assert!(r
                .map_server_message(json!({"event": "BUY2::swap"}))
                .is_some());
        }
        // JS truthiness of isBuyer.
        let mut t = Relay::default();
        t.map_server_message(json!({"event": "new-channel", "data": {"isBuyer": 1, "tradeInfo": {"seller": {"socketId": "S"}, "buyer": {"socketId": "B"}}}}));
        assert!(t.map_server_message(json!({"event": "S::swap"})).is_some());
        t.map_server_message(json!({"event": "new-channel", "data": {"tradeInfo": {"seller": {"socketId": "S"}, "buyer": {"socketId": "B"}}}}));
        assert!(t.map_server_message(json!({"event": "B::swap"})).is_some());
        // A swap name before any new-channel is dropped.
        assert_eq!(
            Relay::default().map_server_message(json!({"event": "S::swap"})),
            None
        );
    }

    fn parsed(text: Option<String>) -> Value {
        serde_json::from_str(&text.expect("a message")).unwrap()
    }

    #[test]
    fn ui_events_are_spread_flat_next_to_the_event_name() {
        let r = Relay::default();
        assert_eq!(
            parsed(r.map_ui_event(
                "new-order",
                Some(&json!({"price": 1.5, "props": {"a": [1]}}))
            )),
            json!({"event": "new-order", "price": 1.5, "props": {"a": [1]}})
        );
        assert_eq!(
            parsed(r.map_ui_event(
                "orderbook:join",
                Some(&json!({"marketKey": "5-4", "network": "LTCTEST"}))
            )),
            json!({"event": "orderbook:join", "marketKey": "5-4", "network": "LTCTEST"})
        );
        for e in UI_EVENTS {
            assert_eq!(parsed(r.map_ui_event(e, None)), json!({"event": e}));
        }
        // A payload key `event` never changes the event name.
        assert_eq!(
            parsed(r.map_ui_event("new-order", Some(&json!({"event": "disconnect", "p": 1})))),
            json!({"event": "new-order", "p": 1})
        );
        // Non-object payloads add nothing, except the many-orders array.
        assert_eq!(
            parsed(r.map_ui_event("close-order", Some(&json!("abc")))),
            json!({"event": "close-order"})
        );
        assert_eq!(
            parsed(r.map_ui_event("many-orders", Some(&json!([{"a": 1}, {"a": 2}])))),
            json!({"event": "many-orders", "orders": [{"a": 1}, {"a": 2}]})
        );
        assert_eq!(
            parsed(r.map_ui_event(
                "many-orders",
                Some(&json!({"orders": [1], "network": "LTCTEST"}))
            )),
            json!({"event": "many-orders", "orders": [1], "network": "LTCTEST"})
        );
        // The UI's channel announcement goes out as `new-channel`.
        assert_eq!(
            parsed(r.map_ui_event("OB_SOCKET::new-channel", Some(&json!({"tradeInfo": {}})))),
            json!({"event": "new-channel", "tradeInfo": {}})
        );
        for e in [
            "connect",
            "ob-sockets-connect",
            "OB_SOCKET::connect",
            "OB_SOCKET::connected",
            "orderbook-data",
            "new-channel",
            "disconnect",
            "ping",
            "x",
        ] {
            assert_eq!(r.map_ui_event(e, None), None, "{e}");
        }
        // Payload bound.
        let big = Value::String("a".repeat(MAX_UI_PAYLOAD));
        assert_eq!(r.map_ui_event("new-order", Some(&big)), None);
        let fits = Value::String("a".repeat(MAX_UI_PAYLOAD - 2));
        assert!(r.map_ui_event("new-order", Some(&fits)).is_some());
        assert_eq!(r.map_ui_event("new-order", Some(&json!({"k": big}))), None);
    }

    #[test]
    fn swap_events_are_bound_to_the_own_id_and_carry_three_fields() {
        let mut r = Relay::default();
        let swap = json!({"eventName": "BUYER:STEP2", "socketId": "Me-1", "data": {"psbt": "x"}, "extra": 1, "event": "evil"});
        assert_eq!(r.map_ui_event("Me-1::swap", Some(&swap)), None);
        r.set_sid("Me-1");
        assert_eq!(
            parsed(r.map_ui_event("Me-1::swap", Some(&swap))),
            json!({"event": "Me-1::swap", "eventName": "BUYER:STEP2", "socketId": "Me-1", "data": {"psbt": "x"}})
        );
        assert_eq!(
            parsed(r.map_ui_event("Me-1::swap", Some(&json!({"eventName": "T"})))),
            json!({"event": "Me-1::swap", "eventName": "T"})
        );
        assert_eq!(
            parsed(r.map_ui_event("Me-1::swap", None)),
            json!({"event": "Me-1::swap"})
        );
        assert_eq!(r.map_ui_event("OTHER::swap", Some(&swap)), None);
        assert_eq!(r.map_ui_event("::swap", None), None);
        assert_eq!(r.map_ui_event("Me-1::swap::swap", None), None);
    }

    // ---- mock orderbook server: a raw WebSocket server like tl-orderbook-server's

    #[derive(Default)]
    struct MockState {
        /// Text frames the server will send, in order.
        outbound: VecDeque<MockOut>,
        /// Text frames received from the client.
        received: Vec<String>,
        pings: usize,
        pongs: usize,
        closes: usize,
        connections: usize,
        /// Request paths and whether an `x-tradelayer-client` header came with them.
        upgrades: Vec<(String, bool)>,
        /// The server is down: connections are dropped without an answer.
        down: bool,
        /// The server reads and writes nothing (a half-open connection).
        stall: bool,
        /// Connections accepted so far; a connection of an older epoch is dropped.
        epoch: u32,
        /// Send the hello on connect.
        greet: bool,
    }

    enum MockOut {
        Text(String),
        Ping,
        Close,
        Drop,
    }

    struct Mock {
        addr: SocketAddr,
        st: Arc<(Mutex<MockState>, Condvar)>,
    }

    const HELLO_ID: &str = "Hello_1";

    impl Mock {
        fn start() -> Mock {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let st: Arc<(Mutex<MockState>, Condvar)> = Arc::default();
            st.0.lock().unwrap().greet = true;
            let st2 = st.clone();
            std::thread::spawn(move || {
                for conn in listener.incoming() {
                    let Ok(stream) = conn else { continue };
                    let st = st2.clone();
                    {
                        let mut g = st.0.lock().unwrap();
                        g.connections += 1;
                        if g.down {
                            continue;
                        }
                    }
                    std::thread::spawn(move || mock_connection(stream, &st));
                }
            });
            Mock { addr, st }
        }

        fn url(&self) -> String {
            format!("ws://{}", self.addr)
        }

        fn ws_url(&self) -> String {
            format!("ws://{}/ws", self.addr)
        }

        fn send(&self, text: &str) {
            self.push(MockOut::Text(text.to_string()));
        }

        fn push(&self, out: MockOut) {
            self.st.0.lock().unwrap().outbound.push_back(out);
            self.st.1.notify_all();
        }

        fn received(&self) -> Vec<String> {
            self.st.0.lock().unwrap().received.clone()
        }

        fn received_json(&self) -> Vec<Value> {
            self.received()
                .iter()
                .filter_map(|t| serde_json::from_str(t).ok())
                .collect()
        }

        fn connections(&self) -> usize {
            self.st.0.lock().unwrap().connections
        }

        /// Take the server down (connections dropped, new ones refused after accept) or bring it
        /// back with no session state, like a restart.
        fn set_down(&self, down: bool) {
            let mut s = self.st.0.lock().unwrap();
            s.down = down;
            if down {
                s.epoch += 1;
            }
            s.outbound.clear();
            drop(s);
            self.st.1.notify_all();
        }

        fn set_stall(&self, stall: bool) {
            self.st.0.lock().unwrap().stall = stall;
            self.st.1.notify_all();
        }

        fn wait_for<T>(&self, what: &str, f: impl Fn(&MockState) -> Option<T>) -> T {
            let end = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(v) = f(&self.st.0.lock().unwrap()) {
                    return v;
                }
                assert!(
                    Instant::now() < end,
                    "mock never saw {what}: {:?}",
                    self.received()
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        fn wait_received(&self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
            self.wait_for(what, |s| {
                s.received
                    .iter()
                    .filter_map(|t| serde_json::from_str::<Value>(t).ok())
                    .find(|v| pred(v))
            })
        }
    }

    fn is_timeout(e: &tungstenite::Error) -> bool {
        matches!(e, tungstenite::Error::Io(io) if matches!(io.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut))
    }

    fn mock_connection(stream: TcpStream, st: &Arc<(Mutex<MockState>, Condvar)>) {
        let st2 = st.clone();
        let cb = move |req: &tungstenite::handshake::server::Request,
                       resp: tungstenite::handshake::server::Response| {
            st2.0.lock().unwrap().upgrades.push((
                req.uri().path().to_string(),
                req.headers().contains_key("x-tradelayer-client"),
            ));
            Ok(resp)
        };
        let Ok(mut ws) = tungstenite::accept_hdr(stream, cb) else {
            return;
        };
        let (mine, greet, id) = {
            let g = st.0.lock().unwrap();
            (g.epoch, g.greet, g.connections)
        };
        let _ = ws
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(10)));
        if greet {
            let hello = format!(
                r#"{{"event":"connected","id":"{HELLO_ID}{}","clientClass":"web","authRequired":true}}"#,
                if id > 1 {
                    format!("_{id}")
                } else {
                    String::new()
                }
            );
            if ws.send(Message::text(hello)).is_err() {
                return;
            }
        }
        loop {
            let next = {
                let mut g = st.0.lock().unwrap();
                if g.down || g.epoch != mine {
                    return;
                }
                if g.stall {
                    drop(g);
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                g.outbound.pop_front()
            };
            match next {
                Some(MockOut::Text(t)) => {
                    if ws.send(Message::text(t)).is_err() {
                        return;
                    }
                }
                Some(MockOut::Ping) => {
                    if ws.send(Message::Ping(Vec::new().into())).is_err() {
                        return;
                    }
                }
                Some(MockOut::Close) => {
                    let _ = ws.close(None);
                    let _ = ws.flush();
                    return;
                }
                Some(MockOut::Drop) => return,
                None => {}
            }
            match ws.read() {
                Ok(Message::Text(t)) => {
                    let mut g = st.0.lock().unwrap();
                    g.received.push(t.as_str().to_string());
                    st.1.notify_all();
                }
                Ok(Message::Ping(_)) => st.0.lock().unwrap().pings += 1,
                Ok(Message::Pong(_)) => st.0.lock().unwrap().pongs += 1,
                Ok(Message::Close(_)) => {
                    st.0.lock().unwrap().closes += 1;
                    let _ = ws.flush();
                    return;
                }
                Ok(_) => {}
                Err(e) if is_timeout(&e) => {}
                Err(_) => return,
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

    /// Short grace window and backoff so reconnects show within a test's time.
    fn quick() -> socketio::Liveness {
        socketio::Liveness {
            ob_grace_ms: 600,
            resume_gap_ms: 60_000,
            ob_backoff_base_ms: 20,
            ob_backoff_cap_ms: 80,
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
            let h = socketio::start_with(Box::new(FakeNode), fast(), policy, quick()).unwrap();
            let mut ui = Ui {
                h,
                sid: String::new(),
                seen: Vec::new(),
            };
            ui.new_session();
            ui
        }

        /// Open a session and connect its namespace (a reconnect of the page's socket.io client).
        fn new_session(&mut self) {
            let open = Ui::call(&self.h, "GET", Q, "");
            let v: Value = serde_json::from_str(&open.body[1..]).unwrap();
            self.sid = v["sid"].as_str().unwrap().to_string();
            assert_eq!(self.post("40"), "ok");
            self.wait_for("40{");
        }

        /// How many packets containing `needle` were seen so far (consumes them).
        fn drain_count(&mut self, needle: &str) -> usize {
            let n = self.seen.iter().filter(|p| p.contains(needle)).count();
            self.seen.retain(|p| !p.contains(needle));
            n
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

    const UI_CONNECT: &str = r#"42["OB_SOCKET::connect",{}]"#;

    #[test]
    fn end_to_end_connect_hello_relay_both_ways_and_ping() {
        let m = Mock::start();
        let mut ui = Ui::connect(policy_for(&m));
        ui.emit(&connect_packet(&m.ws_url()));
        assert_eq!(ui.wait_for("OB_SOCKET::connect\""), UI_CONNECT);
        let got = ui.wait_for("OB_SOCKET::connected");
        assert_eq!(
            parse_server_packet(&got),
            ServerPacket::Event(
                "OB_SOCKET::connected".into(),
                Some(
                    json!({"event": "connected", "id": HELLO_ID, "clientClass": "web", "authRequired": true})
                )
            )
        );
        // The upgrade went to the path the UI named and carried no client-class header.
        assert_eq!(
            m.st.0.lock().unwrap().upgrades,
            vec![("/ws".to_string(), false)]
        );

        // Server -> UI: the whole flat message, prefixed.
        m.send(r#"{"event":"orderbook-data","marketKey":"5-4","orders":{"bids":[["1.5","2"]],"asks":[]},"isDelta":false,"history":[],"note":"a\"b"}"#);
        let got = ui.wait_for("OB_SOCKET::orderbook-data");
        assert_eq!(
            parse_server_packet(&got),
            ServerPacket::Event(
                "OB_SOCKET::orderbook-data".into(),
                Some(
                    json!({"event": "orderbook-data", "marketKey": "5-4", "orders": {"bids": [["1.5", "2"]], "asks": []}, "isDelta": false, "history": [], "note": "a\"b"})
                )
            )
        );
        // Events outside the allowlist and non-JSON text are dropped.
        m.send(r#"{"event":"evil","x":1}"#);
        m.send("not json");
        m.send(r#"[1,2]"#);
        m.send(r#"{"event":"order:saved","orderUuid":"uuid-1"}"#);
        assert_eq!(
            ui.wait_for("OB_SOCKET::order:saved"),
            r#"42["OB_SOCKET::order:saved",{"event":"order:saved","orderUuid":"uuid-1"}]"#
        );
        assert!(ui.seen.iter().all(|p| !p.contains("evil")));

        // UI -> server: flat JSON, the event name first among equals.
        ui.emit(r#"42["new-order",{"price":1.5,"note":"x\"y","event":"disconnect"}]"#);
        let sent = m.wait_received("new-order", |v| v["event"] == "new-order");
        assert_eq!(
            sent,
            json!({"event": "new-order", "price": 1.5, "note": "x\"y"})
        );
        ui.emit(r#"42["not-allowed",1]"#);
        ui.emit(r#"42["disconnect"]"#);
        ui.emit(r#"42["update-orderbook",{"first":1}]"#);
        ui.emit(r#"42["orderbook:join",{"marketKey":"5-4","network":"LTCTEST"}]"#);
        m.wait_received("update-orderbook", |v| v["event"] == "update-orderbook");
        m.wait_received("join", |v| v["event"] == "orderbook:join");
        let events: Vec<Value> = m.received_json();
        assert!(events
            .iter()
            .all(|v| v["event"] != "not-allowed" && v["event"] != "disconnect"));

        // A WebSocket ping from the server is answered with a pong.
        m.push(MockOut::Ping);
        m.wait_for("a pong", |s| (s.pongs > 0).then_some(()));
    }

    #[test]
    fn end_to_end_the_server_closing_is_one_disconnect_then_a_reconnect() {
        let m = Mock::start();
        let mut ui = Ui::connect(policy_for(&m));
        ui.emit(&connect_packet(&m.ws_url()));
        ui.wait_for("OB_SOCKET::connect\"");
        ui.wait_for("OB_SOCKET::connected");
        // A clean close (Close frame) is a loss too, and the client reconnects after it.
        m.push(MockOut::Close);
        assert_eq!(
            ui.wait_for("OB_SOCKET::disconnect"),
            r#"42["OB_SOCKET::disconnect"]"#
        );
        assert_eq!(ui.wait_for("OB_SOCKET::connect\""), UI_CONNECT);
        // The new connection brings a new hello with a new id.
        let hello = ui.wait_for("OB_SOCKET::connected");
        assert!(hello.contains("Hello_1_2"), "{hello}");
        // A dropped TCP connection is the same.
        m.push(MockOut::Drop);
        ui.wait_for("OB_SOCKET::disconnect");
        ui.wait_for("OB_SOCKET::connect\"");
        assert_eq!(ui.drain_count("OB_SOCKET::disconnect"), 0);
        assert_eq!(m.connections(), 3);
    }

    #[test]
    fn end_to_end_swap_events_follow_the_new_channel_counterparty() {
        let m = Mock::start();
        let mut ui = Ui::connect(policy_for(&m));
        ui.emit(&connect_packet(&m.ws_url()));
        ui.wait_for("OB_SOCKET::connected");
        let me = HELLO_ID;
        m.send(r#"{"event":"CpSock::swap","data":{"early":1}}"#);
        m.send(&format!(
            r#"{{"event":"new-channel","data":{{"isBuyer":true,"tradeInfo":{{"seller":{{"socketId":"CpSock"}},"buyer":{{"socketId":"{me}"}}}},"unfilled":0}}}}"#
        ));
        // `new-channel` reaches the UI as `msg.data`.
        let nc = ui.wait_for("OB_SOCKET::new-channel");
        assert_eq!(
            parse_server_packet(&nc),
            ServerPacket::Event(
                "OB_SOCKET::new-channel".into(),
                Some(
                    json!({"isBuyer": true, "tradeInfo": {"seller": {"socketId": "CpSock"}, "buyer": {"socketId": me}}, "unfilled": 0})
                )
            )
        );
        assert!(ui.seen.iter().all(|p| !p.contains("early")));
        m.send(r#"{"event":"CpSock::swap","data":{"eventName":"SELLER:STEP1","socketId":"CpSock","data":{"k":1}}}"#);
        assert_eq!(
            ui.wait_for("CpSock::swap"),
            r#"42["CpSock::swap",{"data":{"k":1},"eventName":"SELLER:STEP1","socketId":"CpSock"}]"#
        );
        m.send(r#"{"event":"Stranger::swap","data":{"x":1}}"#);

        // The UI's own swap channel is forwarded flat with three fields; another name is not.
        ui.emit(&format!(
            r#"42["{me}::swap",{{"eventName":"BUYER:STEP2","socketId":"{me}","data":{{"psbt":"p"}},"junk":1}}]"#
        ));
        ui.emit(r#"42["Stranger::swap",{"x":2}]"#);
        let sent = m.wait_received("own swap", |v| v["event"] == format!("{me}::swap"));
        assert_eq!(
            sent,
            json!({"event": format!("{me}::swap"), "eventName": "BUYER:STEP2", "socketId": me, "data": {"psbt": "p"}})
        );
        // The UI's channel announcement is forwarded as `new-channel`.
        ui.emit(r#"42["OB_SOCKET::new-channel",{"tradeInfo":{"a":1}}]"#);
        m.wait_received("new-channel", |v| v["event"] == "new-channel");
        // A marker event after the dropped one proves it was not forwarded.
        ui.emit(r#"42["close-order",{"orderUUID":"u1"}]"#);
        m.wait_received("marker", |v| v["event"] == "close-order");
        assert!(m.received().iter().all(|p| !p.contains("Stranger")));
        assert!(ui.seen.iter().all(|p| !p.contains("Stranger")));
    }

    #[test]
    fn end_to_end_refused_url_makes_no_connection() {
        let m = Mock::start();
        // The mock's origin is not in the allowlist.
        let mut ui = Ui::connect(ObPolicy::default());
        ui.emit(&connect_packet(&m.ws_url()));
        let got = ui.wait_for("OB_SOCKET::connect_error");
        assert_eq!(
            got,
            r#"42["OB_SOCKET::connect_error","orderbook URL is not in orderbook_urls"]"#
        );
        for bad in [
            format!("{}/ns", m.url()),
            format!("ftp://{}", m.addr),
            "ws://u:p@127.0.0.1:1".to_string(),
            format!("{}/ws?x=1", m.url()),
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
    fn end_to_end_ui_disconnect_closes_the_websocket_politely() {
        let m = Mock::start();
        let mut ui = Ui::connect(policy_for(&m));
        ui.emit(&connect_packet(&m.ws_url()));
        ui.wait_for("OB_SOCKET::connect\"");
        ui.emit(r#"42["ob-sockets-disconnect"]"#);
        assert_eq!(
            ui.wait_for("OB_SOCKET::disconnect"),
            r#"42["OB_SOCKET::disconnect"]"#
        );
        m.wait_for("a close frame", |s| (s.closes > 0).then_some(()));
        // Nothing is relayed any more and nothing reconnects.
        m.send(r#"{"event":"order:saved","orderUuid":"late"}"#);
        ui.assert_absent("late", 400);
        assert_eq!(m.connections(), 1);
    }

    #[test]
    fn end_to_end_an_unclaimed_client_is_stopped_after_the_grace_window() {
        let m = Mock::start();
        let mut ui = Ui::connect(policy_for(&m));
        ui.emit(&connect_packet(&m.ws_url()));
        ui.wait_for("OB_SOCKET::connect\"");
        // The UI's Engine.IO close ends its session; nobody comes back within the grace window.
        ui.emit("1");
        let closed = Instant::now();
        m.wait_for("a close frame", |s| (s.closes > 0).then_some(()));
        assert!(
            closed.elapsed() >= Duration::from_millis(500),
            "stopped too early"
        );
    }

    #[test]
    fn end_to_end_a_reconnecting_ui_keeps_the_relay_and_is_told_its_state() {
        let m = Mock::start();
        let mut ui = Ui::connect(policy_for(&m));
        ui.emit(&connect_packet(&m.ws_url()));
        ui.wait_for("OB_SOCKET::connected");
        ui.emit("1");
        // The page's socket.io client reconnects: new session, same relay, state re-announced:
        // `connect` and the hello, so the UI learns its socket id again.
        ui.new_session();
        assert_eq!(ui.wait_for("OB_SOCKET::connect\""), UI_CONNECT);
        let hello = ui.wait_for("OB_SOCKET::connected");
        assert!(hello.contains(HELLO_ID), "{hello}");
        // Longer than the grace window: the client was handed over, not stopped.
        std::thread::sleep(Duration::from_millis(800));
        assert_eq!(m.st.0.lock().unwrap().closes, 0);
        assert_eq!(m.connections(), 1);
        m.send(r#"{"event":"order:saved","orderUuid":"after-handover"}"#);
        ui.wait_for("after-handover");
        ui.emit(r#"42["close-order",{"orderUUID":"u9"}]"#);
        m.wait_received("forward after handover", |v| v["orderUUID"] == "u9");
    }

    #[test]
    fn end_to_end_server_restart_reports_one_disconnect_and_reconnects_by_itself() {
        let m = Mock::start();
        let mut ui = Ui::connect(policy_for(&m));
        ui.emit(&connect_packet(&m.ws_url()));
        ui.wait_for("OB_SOCKET::connect\"");
        ui.wait_for("OB_SOCKET::connected");
        let before = m.connections();

        m.set_down(true);
        assert_eq!(
            ui.wait_for("OB_SOCKET::disconnect"),
            r#"42["OB_SOCKET::disconnect"]"#
        );
        // While the server is away the client keeps trying (a handful of attempts under the
        // 20..80 ms backoff) and reports nothing more.
        std::thread::sleep(Duration::from_millis(900));
        assert!(
            m.connections() >= before + 3,
            "{} attempts",
            m.connections() - before
        );
        // Events the UI sends meanwhile are dropped, not queued for later.
        ui.emit(r#"42["new-order",{"stale":true}]"#);
        ui.assert_absent("OB_SOCKET::disconnect", 100);
        assert_eq!(ui.drain_count("OB_SOCKET::disconnect"), 0);

        m.set_down(false);
        ui.wait_for("OB_SOCKET::connect\"");
        ui.wait_for("OB_SOCKET::connected");
        // Server -> UI works again, and nothing stale was resent.
        m.send(r#"{"event":"order:saved","orderUuid":"after-restart"}"#);
        ui.wait_for("after-restart");
        ui.emit(r#"42["close-order",{"orderUUID":"fresh"}]"#);
        m.wait_received("fresh event", |v| v["orderUUID"] == "fresh");
        assert!(m.received().iter().all(|p| !p.contains("stale")));
        assert_eq!(ui.drain_count("OB_SOCKET::disconnect"), 0);
    }

    #[test]
    fn end_to_end_an_oversize_server_message_ends_the_connection_and_reconnects() {
        let m = Mock::start();
        let mut ui = Ui::connect(policy_for(&m));
        ui.emit(&connect_packet(&m.ws_url()));
        ui.wait_for("OB_SOCKET::connect\"");
        ui.wait_for("OB_SOCKET::connected");
        m.send(&format!(
            r#"{{"event":"orderbook-data","pad":"{}"}}"#,
            "a".repeat(MAX_WS_MESSAGE)
        ));
        ui.wait_for("OB_SOCKET::disconnect");
        ui.wait_for("OB_SOCKET::connect\"");
        assert!(ui.seen.iter().all(|p| !p.contains("orderbook-data")));
        // An oversize UI payload is refused before it is queued, and does not end anything.
        let big = Value::String("a".repeat(MAX_UI_PAYLOAD));
        ui.emit(&encode_event("new-order", Some(&big)));
        ui.emit(r#"42["close-order",{"orderUUID":"small"}]"#);
        m.wait_received("small", |v| v["orderUUID"] == "small");
        assert!(m.received().iter().all(|p| p.len() < MAX_UI_PAYLOAD));
    }

    fn collecting_sink() -> (Sink, mpsc::Receiver<ObEvent>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        (
            Arc::new(move |_gen, ev| tx.lock().unwrap().send(ev).is_ok()),
            rx,
        )
    }

    fn next_event(rx: &mpsc::Receiver<ObEvent>) -> ObEvent {
        rx.recv_timeout(Duration::from_secs(10)).expect("an event")
    }

    fn quick_reconnect() -> Reconnect {
        Reconnect {
            base_ms: 20,
            cap_ms: 80,
        }
    }

    fn ws_url_of(m: &Mock) -> reqwest::Url {
        reqwest::Url::parse(&m.ws_url()).unwrap()
    }

    /// The hello and the `Connected` event, in the order the UI sees them.
    fn expect_up(rx: &mpsc::Receiver<ObEvent>) {
        assert_eq!(next_event(rx), ObEvent::Connected);
        match next_event(rx) {
            ObEvent::Relay { name, .. } => assert_eq!(name, "OB_SOCKET::connected"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn manager_resume_replaces_the_client_and_reports_the_loss_once() {
        let m = Mock::start();
        let (sink, rx) = collecting_sink();
        let mut mgr = Manager::new(sink, quick_reconnect());
        assert!(mgr
            .apply(ObCmd::Connect {
                gen: 4,
                url: ws_url_of(&m)
            })
            .is_none());
        expect_up(&rx);
        // The machine woke up: the old connection is presumed dead, a new client takes over.
        assert!(mgr.apply(ObCmd::Resume).is_none());
        assert_eq!(next_event(&rx), ObEvent::Disconnected);
        expect_up(&rx);
        assert_eq!(m.connections(), 2);
        // The old client leaves without a goodbye (its connection was presumed dead).
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(m.st.0.lock().unwrap().closes, 0);
        assert!(rx.try_recv().is_err(), "no further events");
        // A resume with no client is a no-op.
        mgr.apply(ObCmd::Stop);
        assert!(mgr.apply(ObCmd::Resume).is_none());
    }

    #[test]
    fn manager_drops_events_while_the_client_is_not_connected() {
        let m = Mock::start();
        let (sink, rx) = collecting_sink();
        let mut mgr = Manager::new(sink, quick_reconnect());
        mgr.apply(ObCmd::Connect {
            gen: 1,
            url: ws_url_of(&m),
        });
        expect_up(&rx);
        m.set_down(true);
        assert_eq!(next_event(&rx), ObEvent::Disconnected);
        for n in 0..500 {
            mgr.apply(ObCmd::Send {
                name: "new-order".into(),
                payload: Some(json!({ "n": n })),
            });
        }
        m.set_down(false);
        expect_up(&rx);
        mgr.apply(ObCmd::Send {
            name: "close-order".into(),
            payload: Some(json!({"orderUUID": "now"})),
        });
        m.wait_received("event after reconnect", |v| v["orderUUID"] == "now");
        assert!(m.received().iter().all(|p| !p.contains("new-order")));
    }

    #[test]
    fn a_silent_server_is_replaced_and_a_live_one_is_pinged() {
        let m = Mock::start();
        let (sink, rx) = collecting_sink();
        let mut mgr = Manager::with_timing(
            sink,
            quick_reconnect(),
            LinkTiming {
                ping_ms: 100,
                dead_ms: 700,
            },
        );
        mgr.apply(ObCmd::Connect {
            gen: 1,
            url: ws_url_of(&m),
        });
        expect_up(&rx);
        // A server that answers pings stays: pings arrive, no loss within several dead windows.
        std::thread::sleep(Duration::from_millis(1_800));
        assert!(
            m.st.0.lock().unwrap().pings >= 5,
            "{}",
            m.st.0.lock().unwrap().pings
        );
        assert!(rx.try_recv().is_err(), "no loss while the server answers");
        // A half-open connection (the server reads and writes nothing) is detected by silence.
        m.set_stall(true);
        assert_eq!(next_event(&rx), ObEvent::Disconnected);
        // The replacement connects once the server is back (a stalled epoch-1 handler stays
        // stalled, so the stall flag is cleared for the new connection).
        m.set_stall(false);
        expect_up(&rx);
        assert!(m.connections() >= 2);
    }

    #[test]
    fn a_failed_first_attempt_is_final_and_a_later_loss_is_not() {
        let dead = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = reqwest::Url::parse(&format!("ws://{}/ws", dead.local_addr().unwrap())).unwrap();
        drop(dead);
        let (sink, rx) = collecting_sink();
        let mut mgr = Manager::new(sink, Reconnect::default());
        mgr.apply(ObCmd::Connect { gen: 1, url });
        match next_event(&rx) {
            ObEvent::ConnectError(r) => assert!(r.contains("orderbook connection failed"), "{r}"),
            other => panic!("{other:?}"),
        }
        std::thread::sleep(Duration::from_millis(300));
        assert!(rx.try_recv().is_err(), "the client ended");
    }

    #[test]
    fn a_server_that_is_not_a_websocket_is_a_connect_error_without_the_address() {
        // A plain HTTP server that answers the upgrade with 200.
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                use std::io::{Read, Write};
                let mut b = [0u8; 1024];
                let _ = s.read(&mut b);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            }
        });
        let (sink, rx) = collecting_sink();
        let mut mgr = Manager::new(sink, Reconnect::default());
        mgr.apply(ObCmd::Connect {
            gen: 1,
            url: reqwest::Url::parse(&format!("ws://{addr}/ws")).unwrap(),
        });
        match next_event(&rx) {
            ObEvent::ConnectError(r) => assert!(!r.contains("127.0.0.1"), "{r}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn backoff_doubles_to_the_cap_and_jitter_stays_inside_the_window() {
        let cfg = Reconnect {
            base_ms: 500,
            cap_ms: 10_000,
        };
        let mut b = Backoff::new(cfg);
        let full: Vec<u64> = (0..8).map(|_| b.next_delay_ms(1.0)).collect();
        assert_eq!(
            full,
            [500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]
        );
        let mut b = Backoff::new(cfg);
        let low: Vec<u64> = (0..7).map(|_| b.next_delay_ms(0.0)).collect();
        assert_eq!(low, [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
        // Any jitter lands between half and the whole of the step; junk jitter is clamped.
        let mut b = Backoff::new(cfg);
        let mids: Vec<u64> = (0..4).map(|_| b.next_delay_ms(0.5)).collect();
        assert_eq!(mids, [375, 750, 1_500, 3_000]);
        let mut b = Backoff::new(cfg);
        assert_eq!(b.next_delay_ms(f64::NAN), 500);
        assert_eq!(b.next_delay_ms(-3.0), 500);
        assert_eq!(b.next_delay_ms(9.0), 2_000);
        // A connection that worked starts the schedule over.
        b.reset();
        assert_eq!(b.next_delay_ms(1.0), 500);
        // Many failures never overflow.
        let mut b = Backoff::new(cfg);
        for _ in 0..10_000 {
            assert!(b.next_delay_ms(1.0) <= 10_000);
        }
        for _ in 0..1000 {
            let j = random_unit();
            assert!((0.0..1.0).contains(&j), "{j}");
        }
    }

    #[test]
    fn the_outbox_is_bounded_and_clearable() {
        let o = Outbox::new();
        for n in 0..OUT_DEPTH + 40 {
            o.push("new-order".into(), Some(json!(n)));
        }
        assert_eq!(o.len(), OUT_DEPTH);
        assert_eq!(o.pop(), Some(("new-order".into(), Some(json!(0)))));
        o.clear();
        assert_eq!(o.len(), 0);
        assert!(o.pop().is_none());
    }

    #[test]
    fn end_to_end_a_new_connect_replaces_the_client() {
        let m1 = Mock::start();
        let m2 = Mock::start();
        let mut ui = Ui::connect(ObPolicy::new(vec![m1.url(), m2.url()]));
        ui.emit(&connect_packet(&m1.ws_url()));
        ui.wait_for("OB_SOCKET::connect\"");
        ui.emit(&connect_packet(&m2.ws_url()));
        ui.wait_for("OB_SOCKET::connect\"");
        m1.wait_for("old client closed", |s| (s.closes > 0).then_some(()));
        m2.send(r#"{"event":"order:saved","orderUuid":"from-two"}"#);
        ui.wait_for("from-two");
        // The old server's events no longer reach the UI.
        m1.send(r#"{"event":"order:saved","orderUuid":"from-one"}"#);
        ui.assert_absent("from-one", 400);
    }

    #[test]
    fn end_to_end_dead_server_is_a_connect_error() {
        // Nothing listens: the connection is refused, and the message names no address.
        let dead = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}", dead.local_addr().unwrap());
        drop(dead);
        let mut ui = Ui::connect(ObPolicy::new(vec![url.clone()]));
        ui.emit(&connect_packet(&format!("{url}/ws")));
        let got = ui.wait_for("OB_SOCKET::connect_error");
        assert!(got.contains("orderbook connection failed"), "{got}");
        assert!(!got.contains("127.0.0.1"), "{got}");
    }

    /// Against a real orderbook server: `TL_OB_URL=ws://127.0.0.1:3001` (the optimized
    /// `tl-orderbook-server` on branch `auth`, run from an export). Run with
    /// `cargo test --locked -- --ignored real_orderbook`. The relay is a `web` class client (the
    /// server reads no class header), so reads work and mutations are answered with
    /// `order:error`.
    #[test]
    #[ignore = "needs a running tl-orderbook-server; set TL_OB_URL"]
    fn real_orderbook_server_round_trip() {
        let base = std::env::var("TL_OB_URL").expect("TL_OB_URL");
        let url = format!("{}/ws", base.trim_end_matches('/'));
        let mut ui = Ui::connect(ObPolicy::new(vec![base.clone()]));
        ui.emit(&connect_packet(&url));
        assert_eq!(ui.wait_for("OB_SOCKET::connect\""), UI_CONNECT);
        let hello = ui.wait_for("OB_SOCKET::connected");
        match parse_server_packet(&hello) {
            ServerPacket::Event(_, Some(p)) => {
                assert_eq!(p["event"], "connected");
                assert!(valid_socket_id(p["id"].as_str().unwrap()), "{p}");
                assert_eq!(p["clientClass"], "web", "{p}");
                assert_eq!(p["authRequired"], true, "{p}");
            }
            other => panic!("unexpected {other:?}"),
        }
        // Read flows: a snapshot request and a market subscription.
        ui.emit(r#"42["update-orderbook",{"type":"SPOT","first_token":4,"second_token":5,"network":"LTCTEST"}]"#);
        let got = ui.wait_for("OB_SOCKET::orderbook-data");
        match parse_server_packet(&got) {
            ServerPacket::Event(name, Some(p)) => {
                assert_eq!(name, "OB_SOCKET::orderbook-data");
                assert_eq!(p["event"], "orderbook-data");
                assert!(p["orders"].is_object() || p["orders"].is_array(), "{p}");
            }
            other => panic!("unexpected {other:?}"),
        }
        ui.emit(r#"42["orderbook:join",{"marketKey":"4-5","network":"LTCTEST"}]"#);
        // A mutation from a web client is refused with the server's reason.
        ui.emit(r#"42["new-order",{"isLimitOrder":true,"type":"SPOT","network":"LTCTEST","props":{"id_for_sale":4,"id_desired":5,"amount":1,"price":1}}]"#);
        let err = ui.wait_for("OB_SOCKET::order:error");
        assert!(err.contains("Authentication required"), "{err}");
        ui.emit(r#"42["ob-sockets-disconnect"]"#);
        ui.wait_for("OB_SOCKET::disconnect");
    }
}
