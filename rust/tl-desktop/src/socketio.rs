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
//! * client `ob-sockets-connect`: the legacy server connected to the remote orderbook and relayed
//!   its events as `OB_SOCKET::*`. This build does not relay yet and answers
//!   `OB_SOCKET::connect_error`; `ob-sockets-disconnect` answers `OB_SOCKET::disconnect`.
//! * server `new-block` `{height, header}` and `core-error`: while a socket is connected the
//!   engine asks the [`NodeProbe`] for `getblockchaininfo` every `probe_interval_ms`. `new-block`
//!   is emitted when the height increases; `core-error` once when a node that had answered stops
//!   answering.

use crate::legacy::ALLOWED_ORIGIN;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::http;

pub const MAX_SESSIONS: usize = 4;
/// Largest request body and largest poll response (the advertised `maxPayload`).
pub const MAX_PAYLOAD: usize = 1_000_000;
pub const MAX_QUEUE: usize = 256;
const QUEUE_DEPTH: usize = 128;
const IDLE_WAIT_MS: u64 = 60_000;
const SEP: char = '\x1e';

pub const OB_UNAVAILABLE: &str = "orderbook relay is not available in the desktop build yet";

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
    /// socket.io EVENT (`42["name", ...]`).
    Event(String),
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
    let json = tail.trim_start_matches(|c: char| c.is_ascii_digit());
    match serde_json::from_str::<Value>(json) {
        Ok(Value::Array(a)) => match a.first() {
            Some(Value::String(s)) => Packet::Event(s.clone()),
            _ => Packet::Ignored,
        },
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

pub struct Engine {
    cfg: Config,
    sessions: Vec<Session>,
}

fn new_id(bytes: usize) -> Option<String> {
    let mut b = vec![0u8; bytes];
    getrandom::fill(&mut b).ok()?;
    Some(b.iter().map(|x| format!("{x:02x}")).collect())
}

impl Engine {
    pub fn new(cfg: Config) -> Engine {
        Engine {
            cfg,
            sessions: Vec::new(),
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
                Packet::Disconnect => self.sessions[i].ns_connected = false,
                Packet::Event(name) => {
                    let s = &mut self.sessions[i];
                    if s.ns_connected {
                        match name.as_str() {
                            "ob-sockets-connect" => s.push(event_packet(
                                "OB_SOCKET::connect_error",
                                Some(OB_UNAVAILABLE),
                            )),
                            "ob-sockets-disconnect" => {
                                s.push(event_packet("OB_SOCKET::disconnect", None))
                            }
                            _ => {}
                        }
                    }
                }
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

    /// Remove session `i`; a held poll is answered with the Engine.IO close packet.
    fn close(&mut self, i: usize) {
        let s = self.sessions.remove(i);
        if let Some(p) = s.pending {
            (p.done)(SioResponse::text("1", None));
        }
    }

    /// Fire due poll timeouts, expire silent sessions and report which sessions need a probe.
    pub fn tick(&mut self, now: u64) -> TickOut {
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
            if s.ns_connected && !s.probe_inflight && s.next_probe_ms <= now {
                s.probe_inflight = true;
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
            out.next_wake_ms = Some(out.next_wake_ms.map_or(wake, |w| w.min(wake)));
            i += 1;
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

/// Start the `socketio` thread.
pub fn start(source: Box<dyn NodeProbe>, cfg: Config) -> std::io::Result<Handle> {
    let (tx, rx) = mpsc::sync_channel::<Cmd>(QUEUE_DEPTH);
    let probe_tx = tx.clone();
    std::thread::Builder::new()
        .name("socketio".into())
        .spawn(move || {
            let start = Instant::now();
            let mut engine = Engine::new(cfg);
            loop {
                let now = elapsed_ms(start);
                let out = engine.tick(now);
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

    #[test]
    fn packets_in_one_post_are_split_on_the_record_separator() {
        let mut e = Engine::new(Config::default());
        let sid = open(&mut e, 0);
        call(&mut e, 0, "POST", &q(&sid), "40").unwrap();
        call(&mut e, 0, "GET", &q(&sid), "").unwrap();
        let body = format!("3{SEP}42[\"ob-sockets-disconnect\"]{SEP}42[\"ob-sockets-connect\",\"wss://ob.example\"]");
        assert_eq!(call(&mut e, 1, "POST", &q(&sid), &body).unwrap().body, "ok");
        let out = call(&mut e, 1, "GET", &q(&sid), "").unwrap().body;
        let parts: Vec<&str> = out.split(SEP).collect();
        assert_eq!(parts[0], r#"42["OB_SOCKET::disconnect"]"#);
        assert_eq!(
            parts[1],
            format!(r#"42["OB_SOCKET::connect_error","{OB_UNAVAILABLE}"]"#)
        );
        assert_eq!(parts.len(), 2);
    }

    #[test]
    fn ob_sockets_connect_produces_the_connect_error_event() {
        let mut e = Engine::new(Config::default());
        let sid = open(&mut e, 0);
        connect(&mut e, 0, &sid);
        // A held poll is released by the event.
        let (held, done) = slot();
        e.handle(1, request("GET", &q(&sid), ""), done);
        assert!(taken(&held).is_none());
        call(
            &mut e,
            2,
            "POST",
            &q(&sid),
            r#"42["ob-sockets-connect","https://ob.example"]"#,
        )
        .unwrap();
        let r = taken(&held).unwrap();
        assert_eq!(
            r.body,
            "42[\"OB_SOCKET::connect_error\",\"orderbook relay is not available in the desktop build yet\"]"
        );
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
            Packet::Event("ob-sockets-disconnect".into())
        );
        assert_eq!(
            parse_packet("4217[\"a\",{\"b\":1}]"),
            Packet::Event("a".into())
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
        let one = r#"42["ob-sockets-disconnect"]"#;
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
        let h = start(Box::new(FakeNode(script)), short()).unwrap();
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
