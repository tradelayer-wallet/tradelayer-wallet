//! Legacy-API bridge: lets the original Angular UI (`packages/wallet-fe`) run inside the Tauri
//! window with no local HTTP server and no Node process.
//!
//! The UI posts JSON to `http://tlapi.localhost/api/<route>` and `/keys/<route>`. On Windows
//! WebView2 serves the Tauri custom URI scheme `tlapi` under that name, so the request never
//! leaves the process: [`Bridge::serve`] is the scheme handler and it hands every request to one
//! dedicated `legacy` thread that owns the [`WalletService`] (the same actor shape as the wallet
//! thread in `main.rs`; blocking node I/O never runs on Tauri's runtime).
//!
//! ## Gate
//!
//! Only this webview can reach a custom scheme, so the bridge supplies the session token itself:
//! 32 bytes from the OS generator at startup, never exposed to the page. The service gate still
//! runs on every request:
//!
//! * peer is loopback (a custom scheme has no remote peers),
//! * `Origin`, when present, must be exactly `http://tauri.localhost` (the page origin);
//!   CORS is echoed only for that origin,
//! * the RPC method allowlist is [`MethodAllowlist::wallet_default`].
//!
//! `tl-wallet-service`'s Host check accepts only `localhost|127.0.0.1|[::1]` plus the gate port
//! (the DNS-rebinding defence for a listening socket). A custom scheme has no DNS, so the bridge
//! checks the URI authority itself (`tlapi.localhost`, or `localhost` on platforms that serve the
//! scheme as `tlapi://localhost`) and presents the gate with the fixed pair `localhost:{GATE_PORT}`.
//!
//! ## Backends
//!
//! * Keys: refused. The legacy key routes return `privkey` and `wif` to the page; the desktop
//!   build keeps key material out of the UI (keys live in the node wallet).
//! * Signing: the node wallet signs ([`crate::nodewallet`]), behind the service's guards, and only
//!   for `wif: ""`; a page-supplied WIF is refused.
//! * Node: generic JSON-RPC 1.0 over blocking `reqwest`, to the endpoint the UI names through
//!   `start-wallet-node` (loopback `http`, or `https`).
//! * Relayer: `POST <base>/rpc/<method>` with `{"params": [...]}`, `https` only, hosts allowlisted
//!   by `relayer_hosts` in the config file (empty: relayer disabled).
//! * Config store: the filesystem, restricted to the node data directory.
//!
//! ## socket.io
//!
//! `/socket.io/...` is served by [`crate::socketio`] (Engine.IO v4 long polling). It reaches the
//! node only through a synthetic `rpc-call` for `getblockchaininfo` on the same `legacy` thread.
//! The orderbook relay (`ob-sockets-connect`) is [`crate::obrelay`]: a socket.io client over
//! long polling to the origins in `orderbook_urls` (default: the two servers of
//! `endpoints.conf.ts`).

use crate::config::LegacySettings;
use crate::nodewallet::{NodeSlot, NodeWalletSigner, SharedConnector};
use crate::obrelay::ObPolicy;
use crate::socketio;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use tauri::http;
use tl_wallet_service::gate::{Gate, GateConfig, MethodAllowlist, SessionToken};
use tl_wallet_service::nodecfg::RpcEndpoint;
use tl_wallet_service::service::{
    CallResult, ConfStore, HttpRequest, HttpResponse, KeyBackend, NodeConnector, RelayerBackend,
    RpcBackend, RpcOutcome, WalletService, MAX_BODY_BYTES,
};

/// The page origin under WebView2 on Windows.
pub const ALLOWED_ORIGIN: &str = "http://tauri.localhost";
const BRIDGE_HOST: &str = "tlapi.localhost";
/// The gate's Host check is loopback name plus this port; the bridge presents it as a constant.
const GATE_PORT: u16 = 1;
const QUEUE_DEPTH: usize = 64;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RESPONSE_BYTES: usize = 8 << 20;
const MAX_CONF_BYTES: u64 = 1 << 20;
const MAX_CONF_WRITE_BYTES: usize = 64 * 1024;
const CONF_NAME: &str = "litecoin.conf";

const KEYS_REFUSED: &str =
    "key material stays out of the UI in the desktop build; keys live in the node wallet";

// ------------------------------------------------------------------ replies

/// What goes back to the webview.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
    /// Value of `Access-Control-Allow-Origin`; `None` means no CORS headers.
    pub allow_origin: Option<String>,
    /// Answer to an `OPTIONS` preflight.
    pub preflight: bool,
}

impl Reply {
    fn early(status: u16, message: &str, origin: Option<&str>) -> Reply {
        Reply {
            status,
            body: json!({ "error": message }),
            allow_origin: origin.filter(|o| *o == ALLOWED_ORIGIN).map(str::to_string),
            preflight: false,
        }
    }

    fn from_service(r: HttpResponse, preflight: bool) -> Reply {
        Reply {
            status: r.status,
            body: r.body,
            allow_origin: r.allow_origin,
            preflight,
        }
    }

    pub fn into_response(self) -> http::Response<Vec<u8>> {
        let status = http::StatusCode::from_u16(self.status)
            .unwrap_or(http::StatusCode::INTERNAL_SERVER_ERROR);
        let body = if self.body.is_null() || status == http::StatusCode::NO_CONTENT {
            Vec::new()
        } else {
            self.body.to_string().into_bytes()
        };
        let mut b = http::Response::builder()
            .status(status)
            .header("Cache-Control", "no-store")
            .header("Vary", "Origin");
        if !body.is_empty() {
            b = b.header("Content-Type", "application/json");
        }
        if let Some(o) = &self.allow_origin {
            b = b.header("Access-Control-Allow-Origin", o.as_str());
            if self.preflight {
                b = b
                    .header("Access-Control-Allow-Methods", "POST, OPTIONS")
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

/// Answer for a request that arrives before the bridge exists.
pub fn unavailable() -> http::Response<Vec<u8>> {
    Reply::early(503, "legacy bridge not running", None).into_response()
}

// ------------------------------------------------------------------ translation

/// The result of translating a webview request.
#[derive(Debug)]
pub enum Translated {
    /// Goes to the wallet service.
    Forward(Box<HttpRequest>),
    /// Answered without reaching the service.
    Answer(Reply),
    /// A `/socket.io/` request: served by the socket.io engine, not the service.
    SocketIo,
}

/// Map a custom-scheme request onto the service request. `token` is the bridge's own session
/// token. The query string never reaches the service; an empty body is JSON `null`.
pub fn translate(req: &http::Request<Vec<u8>>, token: &str) -> Translated {
    let origin_header = req.headers().get("origin").map(|v| v.to_str().ok());
    // A non-UTF-8 Origin cannot equal the allowlisted one: present it as an unmatchable value.
    let origin: Option<String> = origin_header.map(|o| o.unwrap_or("<invalid>").to_string());
    let o = origin.as_deref();
    if let Some(h) = req.uri().host() {
        if !h.eq_ignore_ascii_case(BRIDGE_HOST) && !h.eq_ignore_ascii_case("localhost") {
            return Translated::Answer(Reply::early(403, "denied: BadHost", o));
        }
    }
    let path = req.uri().path();
    if path == "/socket.io" || path.starts_with("/socket.io/") {
        return Translated::SocketIo;
    }
    let method = req.method().as_str().to_string();
    let (body, body_len) = if method == "OPTIONS" {
        (Value::Null, 0)
    } else {
        let raw = req.body();
        if raw.len() > MAX_BODY_BYTES {
            return Translated::Answer(Reply::early(413, "body too large", o));
        }
        if raw.is_empty() {
            (Value::Null, 0)
        } else {
            match serde_json::from_slice::<Value>(raw) {
                Ok(v) => (v, raw.len()),
                Err(_) => return Translated::Answer(Reply::early(400, "invalid JSON body", o)),
            }
        }
    };
    Translated::Forward(Box::new(HttpRequest {
        method,
        path: path.to_string(),
        peer_is_loopback: true,
        host: Some(format!("localhost:{GATE_PORT}")),
        origin,
        token: Some(token.to_string()),
        body_len,
        body,
    }))
}

/// One request on the legacy thread. `POST /tl/<method>` with `{params}` is the TradeLayer node
/// HTTP API that wallet-fe's `NewTradeLayerApiService` called at `http://localhost:3000` (it
/// returns the bare result). It is served as an `rpc-call` of `<method>`, so the gate and the
/// method allowlist apply exactly as for `/api/rpc-call`; a node error becomes HTTP 500.
pub fn handle_request(s: &mut WalletService, req: &HttpRequest) -> Reply {
    let preflight = req.method == "OPTIONS";
    let Some(method) = req.path.strip_prefix("/tl/") else {
        return Reply::from_service(s.handle(req), preflight);
    };
    let mut q = req.clone();
    q.path = "/api/rpc-call".into();
    if preflight {
        return Reply::from_service(s.handle(&q), true);
    }
    // Legacy callers pass either an array or a single value (`tl_getallbalancesforaddress`).
    let params = match req.body.get("params") {
        None | Some(Value::Null) => json!([]),
        Some(Value::Array(a)) => Value::Array(a.clone()),
        Some(other) => json!([other]),
    };
    q.body = json!({ "method": method, "params": params });
    q.body_len = q.body.to_string().len();
    let mut reply = Reply::from_service(s.handle(&q), false);
    if reply.status == 200 {
        match reply.body.get("data").cloned() {
            Some(data) => reply.body = data,
            None => reply.status = 500,
        }
    }
    reply
}

// ------------------------------------------------------------------ the legacy thread

type Done = Box<dyn FnOnce(Reply) + Send>;
type Job = (Box<HttpRequest>, Done);

/// What Tauri holds: a bounded channel to the `legacy` thread plus the bridge's session token.
pub struct Bridge {
    tx: mpsc::SyncSender<Job>,
    token: String,
    sio: socketio::Handle,
}

impl Bridge {
    /// Start the `legacy` thread. `build` runs on that thread and constructs the service there,
    /// so the service need not be `Send`.
    #[cfg(test)]
    pub fn start(
        build: impl FnOnce() -> Result<WalletService, String> + Send + 'static,
        token: &SessionToken,
    ) -> std::io::Result<Bridge> {
        Bridge::start_with(build, token, socketio::Config::default())
    }

    /// [`Bridge::start`] with explicit socket.io timing.
    #[cfg(test)]
    pub fn start_with(
        build: impl FnOnce() -> Result<WalletService, String> + Send + 'static,
        token: &SessionToken,
        sio_config: socketio::Config,
    ) -> std::io::Result<Bridge> {
        Bridge::start_full(build, token, sio_config, ObPolicy::default())
    }

    /// [`Bridge::start_with`] with an explicit orderbook allowlist.
    pub fn start_full(
        build: impl FnOnce() -> Result<WalletService, String> + Send + 'static,
        token: &SessionToken,
        sio_config: socketio::Config,
        policy: ObPolicy,
    ) -> std::io::Result<Bridge> {
        let (tx, rx) = mpsc::sync_channel::<Job>(QUEUE_DEPTH);
        std::thread::Builder::new()
            .name("legacy".into())
            .spawn(move || {
                let mut service = build();
                for (req, done) in rx {
                    let reply = match service.as_mut() {
                        Ok(s) => handle_request(s, &req),
                        Err(e) => Reply::early(500, e, req.origin.as_deref()),
                    };
                    done(reply);
                }
            })?;
        let probe = ServiceProbe {
            tx: tx.clone(),
            token: token.to_hex(),
        };
        let sio = socketio::start(Box::new(probe), sio_config, policy)?;
        Ok(Bridge {
            tx,
            token: token.to_hex(),
            sio,
        })
    }

    /// Translate and queue one JSON request; `done` receives the reply (possibly before this
    /// returns). A socket.io request is answered 404 here: [`Bridge::dispatch`] serves it.
    #[cfg(test)]
    pub fn submit(&self, req: &http::Request<Vec<u8>>, done: Done) {
        match translate(req, &self.token) {
            Translated::Answer(r) => done(r),
            Translated::SocketIo => {
                done(Reply::early(404, "socket.io is served by dispatch", None))
            }
            Translated::Forward(r) => self.forward(r, done),
        }
    }

    /// Serve any `tlapi` request: JSON routes through the service, `/socket.io/` through the
    /// socket.io engine. `respond` is called once, possibly long after this returns (a held poll).
    pub fn dispatch(
        &self,
        req: http::Request<Vec<u8>>,
        respond: Box<dyn FnOnce(http::Response<Vec<u8>>) + Send>,
    ) {
        match translate(&req, &self.token) {
            Translated::SocketIo => self.sio.serve(
                socketio::SioRequest::from_http(&req),
                Box::new(move |r| respond(r.into_response())),
            ),
            Translated::Answer(r) => respond(r.into_response()),
            Translated::Forward(r) => {
                self.forward(r, Box::new(move |r| respond(r.into_response())))
            }
        }
    }

    /// The `tlapi` scheme handler.
    pub fn serve(&self, req: http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
        self.dispatch(req, Box::new(move |r| responder.respond(r)));
    }

    fn forward(&self, r: Box<HttpRequest>, done: Done) {
        match self.tx.try_send((r, done)) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full((_, done))) => {
                done(Reply::early(503, "legacy bridge busy", None))
            }
            Err(mpsc::TrySendError::Disconnected((_, done))) => {
                done(Reply::early(503, "legacy bridge stopped", None))
            }
        }
    }
}

/// Block information for the socket.io engine: a synthetic `rpc-call` for `getblockchaininfo`
/// queued to the `legacy` thread with the bridge's own token, so it passes the same gate and
/// method allowlist as a call from the page.
struct ServiceProbe {
    tx: mpsc::SyncSender<Job>,
    token: String,
}

impl socketio::NodeProbe for ServiceProbe {
    fn probe(&self, done: Box<dyn FnOnce(socketio::Probe) + Send>) {
        let body = json!({ "method": "getblockchaininfo", "params": [] });
        let req = HttpRequest {
            method: "POST".into(),
            path: "/api/rpc-call".into(),
            peer_is_loopback: true,
            host: Some(format!("localhost:{GATE_PORT}")),
            origin: Some(ALLOWED_ORIGIN.into()),
            token: Some(self.token.clone()),
            body_len: body.to_string().len(),
            body,
        };
        let job: Job = (
            Box::new(req),
            Box::new(move |reply: Reply| done(interpret_probe(&reply))),
        );
        if let Err(e) = self.tx.try_send(job) {
            let (mpsc::TrySendError::Full((_, d)) | mpsc::TrySendError::Disconnected((_, d))) = e;
            d(Reply::early(503, "legacy bridge busy", None));
        }
    }
}

/// The service's text for `rpc-call` before `start-wallet-node` succeeded.
const NO_NODE: &str = "No RPC Client initialized";

/// Map the reply of the synthetic `getblockchaininfo` call.
fn interpret_probe(reply: &Reply) -> socketio::Probe {
    if reply.status == 503 {
        return socketio::Probe::Skip;
    }
    if reply.status == 200 {
        let data = &reply.body["data"];
        return match data["blocks"].as_u64() {
            Some(height) => socketio::Probe::Info {
                height,
                headers: data["headers"].as_u64().unwrap_or(height),
            },
            None => socketio::Probe::Error("getblockchaininfo returned no block height".into()),
        };
    }
    match reply.body["error"].as_str() {
        Some(NO_NODE) => socketio::Probe::NotConnected,
        Some(e) => socketio::Probe::Error(e.to_string()),
        None => socketio::Probe::Error(format!("node call failed with HTTP {}", reply.status)),
    }
}

/// Generate the session token, build the service from the config file's settings and start the
/// thread.
pub fn start(
    settings: Result<LegacySettings, String>,
    default_node_dir: PathBuf,
) -> std::io::Result<Bridge> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|e| std::io::Error::other(format!("entropy unavailable: {e}")))?;
    let token = SessionToken::from_bytes(&bytes)
        .map_err(|e| std::io::Error::other(format!("session token: {e:?}")))?;
    let gate_token = token.clone();
    // An unreadable config file leaves the orderbook allowlist empty rather than the defaults.
    let policy = match &settings {
        Ok(s) => ObPolicy::new(s.orderbook_urls.clone()),
        Err(_) => ObPolicy::none(),
    };
    Bridge::start_full(
        move || build_service(settings, default_node_dir, gate_token),
        &token,
        socketio::Config::default(),
        policy,
    )
}

/// The platform's Litecoin data directory: `%APPDATA%\Litecoin` on Windows,
/// `~/Library/Application Support/Litecoin` on macOS, `~/.litecoin` elsewhere.
pub fn default_node_dir(data_dir: &Path, home_dir: &Path) -> PathBuf {
    if cfg!(any(windows, target_os = "macos")) {
        data_dir.join("Litecoin")
    } else {
        home_dir.join(".litecoin")
    }
}

fn gate(token: SessionToken) -> Gate {
    Gate::new(GateConfig {
        port: GATE_PORT,
        token,
        allowed_origins: vec![ALLOWED_ORIGIN.to_string()],
        methods: MethodAllowlist::wallet_default(),
    })
}

fn build_service(
    settings: Result<LegacySettings, String>,
    default_node_dir: PathBuf,
    token: SessionToken,
) -> Result<WalletService, String> {
    let settings = settings.map_err(|e| format!("config: {e}"))?;
    let dir = settings.node_data_dir.unwrap_or(default_node_dir);
    let slot = NodeSlot::default();
    Ok(WalletService::new(
        gate(token),
        Box::new(RefuseKeys),
        Box::new(NodeWalletSigner::new(slot.clone())),
        Box::new(FsConfStore::new(dir.clone())),
        Box::new(SharedConnector::new(HttpConnector, slot)),
        Box::new(HttpRelayer::new()?),
        settings.relayer_hosts,
        dir.to_string_lossy().into_owned(),
    ))
}

// ------------------------------------------------------------------ keys and signing

/// The legacy key routes return `privkey` and `wif` to the page. In the desktop build the page is
/// never trusted with key material: this backend refuses. Signing is the node wallet's
/// ([`crate::nodewallet::NodeWalletSigner`], `wif: ""` only).
struct RefuseKeys;

impl KeyBackend for RefuseKeys {
    fn new_mnemonic(&mut self, _network: &str) -> Result<String, String> {
        Err(KEYS_REFUSED.into())
    }

    fn key_pair(&mut self, _network: &str, _mnemonic: &str, _path: &str) -> CallResult {
        Err(KEYS_REFUSED.into())
    }
}

// ------------------------------------------------------------------ HTTP plumbing

fn is_loopback_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    h.eq_ignore_ascii_case("localhost")
        || h.parse::<std::net::IpAddr>()
            .map(|a| a.is_loopback())
            .unwrap_or(false)
}

/// `https`, or `http` to a loopback host when `https_only` is false. No userinfo, query or
/// fragment.
fn checked_url(url: &str, https_only: bool) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(url).map_err(|_| "malformed URL".to_string())?;
    let host = u.host_str().ok_or("URL has no host")?;
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("URL must not carry credentials, query or fragment".into());
    }
    match u.scheme() {
        "https" => {}
        "http" if !https_only && is_loopback_host(host) => {}
        "http" if !https_only => return Err("http is accepted only for loopback hosts".into()),
        _ => return Err("URL scheme not allowed".into()),
    }
    Ok(u)
}

/// No environment proxy, no redirects (credentials stay at the chosen origin), 10 s connect,
/// 60 s total. `localhost` is pinned to 127.0.0.1 whatever the resolver says.
fn http_client(url: &reqwest::Url) -> Result<reqwest::blocking::Client, String> {
    http_client_with(url, CONNECT_TIMEOUT, TOTAL_TIMEOUT)
}

/// [`http_client`] with explicit connect and per-request timeouts.
pub(crate) fn http_client_with(
    url: &reqwest::Url,
    connect: Duration,
    total: Duration,
) -> Result<reqwest::blocking::Client, String> {
    let mut b = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(0)
        .connect_timeout(connect)
        .timeout(total);
    if url.host_str() == Some("localhost") {
        let port = url.port_or_known_default().ok_or("URL has no port")?;
        b = b.resolve(
            "localhost",
            std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        );
    }
    b.build().map_err(|e| format!("http client: {e}"))
}

/// Read at most `max` bytes; one more byte than that is an error.
pub(crate) fn read_bounded(r: impl Read, max: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    r.take(max as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("response read failed: {e}"))?;
    if out.len() > max {
        return Err("response too large".into());
    }
    Ok(out)
}

fn post_json(
    client: &reqwest::blocking::Client,
    url: reqwest::Url,
    auth: Option<(&str, &str)>,
    body: &Value,
) -> Result<(u16, Vec<u8>), String> {
    let mut rb = client
        .post(url)
        .header("Content-Type", "application/json")
        .body(body.to_string());
    if let Some((u, p)) = auth {
        rb = rb.basic_auth(u, Some(p));
    }
    let resp = rb
        .send()
        .map_err(|e| format!("request failed: {}", e.without_url()))?;
    if resp
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
    {
        return Err("response too large".into());
    }
    let status = resp.status().as_u16();
    Ok((status, read_bounded(resp, MAX_RESPONSE_BYTES)?))
}

fn error_message(e: &Value) -> String {
    match e {
        Value::String(s) => s.clone(),
        Value::Object(o) => o
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| e.to_string()),
        other => other.to_string(),
    }
}

// ------------------------------------------------------------------ node JSON-RPC

/// JSON-RPC 1.0 client over blocking `reqwest` (the version and features `tl-rpc-client` pins).
/// The method allowlist is enforced by the service gate before a call reaches this type.
pub struct RpcClient {
    client: reqwest::blocking::Client,
    url: reqwest::Url,
    user: String,
    password: String,
    next_id: u64,
}

impl RpcClient {
    pub fn new(url: &str, user: &str, password: &str) -> Result<RpcClient, String> {
        let url = checked_url(url, false)?;
        Ok(RpcClient {
            client: http_client(&url)?,
            url,
            user: user.to_string(),
            password: password.to_string(),
            next_id: 0,
        })
    }
}

/// Bitcoin/Litecoin Core answer errors with HTTP 500 and a JSON body, so the body is read first.
fn interpret_rpc(status: u16, body: &[u8]) -> CallResult {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    if let Some(e) = parsed.as_ref().and_then(|v| v.get("error")) {
        if !e.is_null() {
            return Err(error_message(e));
        }
    }
    if !(200..300).contains(&status) {
        return Err(format!("node returned HTTP {status}"));
    }
    match parsed {
        Some(v) => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
        None => Err("node returned invalid JSON".into()),
    }
}

/// [`interpret_rpc`] keeping the node's JSON-RPC error code.
fn interpret_rpc_detailed(status: u16, body: &[u8]) -> RpcOutcome {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    if let Some(e) = parsed.as_ref().and_then(|v| v.get("error")) {
        if !e.is_null() {
            return match e.get("code").and_then(Value::as_i64) {
                Some(code) => RpcOutcome::RpcError {
                    code,
                    message: error_message(e),
                },
                None => RpcOutcome::Failed(error_message(e)),
            };
        }
    }
    match interpret_rpc(status, body) {
        Ok(v) => RpcOutcome::Ok(v),
        Err(e) => RpcOutcome::Failed(e),
    }
}

impl RpcClient {
    fn post_call(&mut self, method: &str, params: &[Value]) -> Result<(u16, Vec<u8>), String> {
        self.next_id += 1;
        let body = json!({
            "jsonrpc": "1.0",
            "id": self.next_id,
            "method": method,
            "params": params,
        });
        let (status, bytes) = post_json(
            &self.client,
            self.url.clone(),
            Some((&self.user, &self.password)),
            &body,
        )?;
        Ok((status, bytes.to_vec()))
    }
}

impl RpcBackend for RpcClient {
    fn call_detailed(&mut self, method: &str, params: &[Value]) -> RpcOutcome {
        match self.post_call(method, params) {
            Ok((status, bytes)) => interpret_rpc_detailed(status, &bytes),
            Err(e) => RpcOutcome::Failed(e),
        }
    }

    fn call(&mut self, method: &str, params: &[Value]) -> CallResult {
        self.next_id += 1;
        let body = json!({
            "jsonrpc": "1.0",
            "id": self.next_id,
            "method": method,
            "params": params,
        });
        let (status, bytes) = post_json(
            &self.client,
            self.url.clone(),
            Some((&self.user, &self.password)),
            &body,
        )?;
        interpret_rpc(status, &bytes)
    }
}

/// Connects to the endpoint the UI named through `start-wallet-node`. The service has already
/// restricted its host to loopback.
struct HttpConnector;

impl NodeConnector for HttpConnector {
    fn connect(&mut self, ep: &RpcEndpoint, _testnet: bool) -> Result<Box<dyn RpcBackend>, String> {
        let host = if ep.host.contains(':') {
            format!("[{}]", ep.host)
        } else {
            ep.host.clone()
        };
        let url = format!("http://{host}:{}/", ep.port);
        Ok(Box::new(RpcClient::new(&url, &ep.user, &ep.password)?))
    }
}

// ------------------------------------------------------------------ relayer

/// `POST <base>/rpc/<method>` with `{"params": [...]}`; the relayer answers `{ "data": ... }` or
/// `{ "error": ... }`.
struct HttpRelayer {
    client: reqwest::blocking::Client,
}

impl HttpRelayer {
    fn new() -> Result<HttpRelayer, String> {
        let probe = reqwest::Url::parse("https://relayer.invalid/").map_err(|e| e.to_string())?;
        Ok(HttpRelayer {
            client: http_client(&probe)?,
        })
    }
}

fn interpret_relayer(status: u16, body: &[u8]) -> CallResult {
    let v: Value =
        serde_json::from_slice(body).map_err(|_| format!("relayer returned HTTP {status}"))?;
    if let Some(e) = v.get("error") {
        if !e.is_null() {
            return Err(error_message(e));
        }
    }
    if !(200..300).contains(&status) {
        return Err(format!("relayer returned HTTP {status}"));
    }
    v.get("data")
        .cloned()
        .ok_or_else(|| "relayer response has no data".to_string())
}

impl RelayerBackend for HttpRelayer {
    fn call(&mut self, base_url: &str, method: &str, params: &[Value]) -> CallResult {
        let well_formed = !method.is_empty()
            && method.len() <= 64
            && method
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_');
        if !well_formed {
            return Err("relayer method malformed".into());
        }
        let url = checked_url(
            &format!("{}/rpc/{method}", base_url.trim_end_matches('/')),
            true,
        )?;
        let (status, bytes) = post_json(&self.client, url, None, &json!({ "params": params }))?;
        interpret_relayer(status, &bytes)
    }
}

// ------------------------------------------------------------------ config store

/// File access restricted to one directory (the node data directory). Paths must be absolute and
/// free of `..`; they are canonicalised (symlinks resolved) and must land inside the root. Reads
/// and creates touch only `litecoin.conf`.
pub struct FsConfStore {
    root: PathBuf,
}

impl FsConfStore {
    pub fn new(root: PathBuf) -> FsConfStore {
        FsConfStore { root }
    }

    fn resolve(&self, p: &str) -> Option<PathBuf> {
        if p.is_empty() || p.len() > 1024 || p.contains('\0') {
            return None;
        }
        let path = Path::new(p);
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return None;
        }
        let root = std::fs::canonicalize(&self.root).ok()?;
        let resolved = match std::fs::canonicalize(path) {
            Ok(c) => c,
            // The leaf may not exist yet: its parent must.
            Err(_) => std::fs::canonicalize(path.parent()?)
                .ok()?
                .join(path.file_name()?),
        };
        resolved.starts_with(&root).then_some(resolved)
    }

    fn resolve_conf(&self, p: &str) -> Option<PathBuf> {
        let r = self.resolve(p)?;
        r.file_name()?
            .to_str()?
            .eq_ignore_ascii_case(CONF_NAME)
            .then_some(r)
    }
}

impl ConfStore for FsConfStore {
    fn dir_exists(&self, dir: &str) -> bool {
        self.resolve(dir).is_some_and(|p| p.is_dir())
    }

    fn file_exists(&self, path: &str) -> bool {
        self.resolve(path)
            .is_some_and(|p| std::fs::symlink_metadata(p).is_ok())
    }

    fn read(&self, path: &str) -> Option<String> {
        let p = self.resolve_conf(path)?;
        let f = std::fs::File::open(p).ok()?;
        if f.metadata().ok()?.len() > MAX_CONF_BYTES {
            return None;
        }
        let mut s = String::new();
        f.take(MAX_CONF_BYTES + 1).read_to_string(&mut s).ok()?;
        (s.len() as u64 <= MAX_CONF_BYTES).then_some(s)
    }

    fn write_new(&mut self, path: &str, contents: &str) -> Result<(), String> {
        let p = self
            .resolve_conf(path)
            .ok_or("path is outside the node data directory")?;
        if contents.len() > MAX_CONF_WRITE_BYTES {
            return Err("config too large".into());
        }
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(p)
            .map_err(|e| format!("cannot create {CONF_NAME}: {}", e.kind()))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("cannot write {CONF_NAME}: {}", e.kind()))
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::net::{TcpListener, TcpStream};
    use tl_wallet_service::mem::{MemConnector, MemRelayer, MemRpc, MemStore};
    use tl_wallet_service::service::SignBackend;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn req(method: &str, uri: &str, origin: Option<&str>, body: &[u8]) -> http::Request<Vec<u8>> {
        let mut b = http::Request::builder().method(method).uri(uri);
        if let Some(o) = origin {
            b = b.header("Origin", o);
        }
        b.body(body.to_vec()).unwrap()
    }

    fn forwarded(t: Translated) -> HttpRequest {
        match t {
            Translated::Forward(r) => *r,
            other => panic!("expected forward, got {other:?}"),
        }
    }

    fn answered(t: Translated) -> Reply {
        match t {
            Translated::Answer(r) => r,
            other => panic!("expected answer, got {other:?}"),
        }
    }

    // ---- translation

    #[test]
    fn translation_strips_query_and_builds_the_service_request() {
        let r = forwarded(translate(
            &req(
                "POST",
                "http://tlapi.localhost/api/rpc-call?x=1&y=%2e%2e#frag",
                Some(ALLOWED_ORIGIN),
                br#"{"method":"getblockchaininfo","params":[]}"#,
            ),
            TOKEN,
        ));
        assert_eq!(r.method, "POST");
        assert_eq!(r.path, "/api/rpc-call");
        assert!(r.peer_is_loopback);
        assert_eq!(r.host.as_deref(), Some("localhost:1"));
        assert_eq!(r.origin.as_deref(), Some(ALLOWED_ORIGIN));
        assert_eq!(r.token.as_deref(), Some(TOKEN));
        assert_eq!(
            r.body_len,
            r#"{"method":"getblockchaininfo","params":[]}"#.len()
        );
        assert_eq!(r.body["method"], "getblockchaininfo");
    }

    #[test]
    fn empty_body_is_null_and_bad_json_is_400() {
        let r = forwarded(translate(
            &req(
                "POST",
                "http://tlapi.localhost/api/stop-wallet-node",
                None,
                b"",
            ),
            TOKEN,
        ));
        assert_eq!(r.body, Value::Null);
        assert_eq!(r.body_len, 0);
        assert_eq!(r.origin, None);
        let a = answered(translate(
            &req(
                "POST",
                "http://tlapi.localhost/api/rpc-call",
                None,
                b"{not json",
            ),
            TOKEN,
        ));
        assert_eq!(a.status, 400);
    }

    #[test]
    fn oversize_body_is_413_before_the_service() {
        let big = vec![b' '; MAX_BODY_BYTES + 1];
        let a = answered(translate(
            &req(
                "POST",
                "http://tlapi.localhost/api/rpc-call",
                Some(ALLOWED_ORIGIN),
                &big,
            ),
            TOKEN,
        ));
        assert_eq!(a.status, 413);
        assert_eq!(a.allow_origin.as_deref(), Some(ALLOWED_ORIGIN));
        // The limit itself is admitted by translation (here: whitespace is not JSON).
        let edge = vec![b' '; MAX_BODY_BYTES];
        assert_eq!(
            answered(translate(
                &req("POST", "http://tlapi.localhost/api/rpc-call", None, &edge),
                TOKEN
            ))
            .status,
            400
        );
    }

    #[test]
    fn socket_io_is_routed_to_the_engine_and_foreign_hosts_are_answered_early() {
        for p in [
            "http://tlapi.localhost/socket.io/?EIO=4&transport=polling",
            "http://tlapi.localhost/socket.io/",
            "http://tlapi.localhost/socket.io",
        ] {
            let t = translate(&req("GET", p, Some(ALLOWED_ORIGIN), b""), TOKEN);
            assert!(matches!(t, Translated::SocketIo), "{p}");
        }
        // A non-JSON socket.io POST body never reaches the JSON parser.
        let t = translate(
            &req(
                "POST",
                "http://tlapi.localhost/socket.io/?EIO=4&transport=polling&sid=x",
                Some(ALLOWED_ORIGIN),
                b"40",
            ),
            TOKEN,
        );
        assert!(matches!(t, Translated::SocketIo));
        let a = answered(translate(
            &req("GET", "http://evil.example/socket.io/", None, b""),
            TOKEN,
        ));
        assert_eq!(a.status, 403);
        let a = answered(translate(
            &req("POST", "http://evil.example/api/rpc-call", None, b"{}"),
            TOKEN,
        ));
        assert_eq!(a.status, 403);
    }

    // ---- end to end through WalletService::handle

    struct Fixture {
        svc: WalletService,
        node: MemRpc,
        store: MemStore,
    }

    fn fixture() -> Fixture {
        let token = SessionToken::from_hex(TOKEN).unwrap();
        let conn = MemConnector::default();
        let store = MemStore::default();
        let node = conn.node.clone();
        let svc = WalletService::new(
            gate(token),
            Box::new(RefuseKeys),
            Box::new(NodeWalletSigner::new(NodeSlot::default())),
            Box::new(store.clone()),
            Box::new(conn),
            Box::new(MemRelayer::default()),
            vec![],
            "/ltc".into(),
        );
        Fixture { svc, node, store }
    }

    fn run(f: &mut Fixture, r: http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
        let reply = match translate(&r, TOKEN) {
            Translated::Answer(a) => a,
            Translated::Forward(q) => handle_request(&mut f.svc, &q),
            Translated::SocketIo => panic!("socket.io is not a service request"),
        };
        reply.into_response()
    }

    fn json_of(r: &http::Response<Vec<u8>>) -> Value {
        serde_json::from_slice(r.body()).unwrap_or(Value::Null)
    }

    fn acao(r: &http::Response<Vec<u8>>) -> Option<&str> {
        r.headers()
            .get("access-control-allow-origin")
            .and_then(|v| v.to_str().ok())
    }

    #[test]
    fn cors_is_echoed_for_the_page_origin_only() {
        let mut f = fixture();
        let ok = run(
            &mut f,
            req(
                "POST",
                "http://tlapi.localhost/api/stop-wallet-node",
                Some(ALLOWED_ORIGIN),
                b"",
            ),
        );
        assert_eq!(ok.status(), 200);
        assert_eq!(acao(&ok), Some(ALLOWED_ORIGIN));
        assert_eq!(ok.headers()["content-type"], "application/json");
        assert!(ok.headers().get("access-control-allow-methods").is_none());

        let foreign = run(
            &mut f,
            req(
                "POST",
                "http://tlapi.localhost/api/stop-wallet-node",
                Some("http://evil.example"),
                b"",
            ),
        );
        assert_eq!(foreign.status(), 403);
        assert_eq!(acao(&foreign), None);
        assert!(foreign
            .headers()
            .get("access-control-allow-headers")
            .is_none());
    }

    #[test]
    fn preflight_answers_allowed_origin_with_methods_and_headers() {
        let mut f = fixture();
        let pre = run(
            &mut f,
            req(
                "OPTIONS",
                "http://tlapi.localhost/api/rpc-call",
                Some(ALLOWED_ORIGIN),
                b"",
            ),
        );
        assert_eq!(pre.status(), 204);
        assert!(pre.body().is_empty());
        assert_eq!(acao(&pre), Some(ALLOWED_ORIGIN));
        assert_eq!(
            pre.headers()["access-control-allow-methods"],
            "POST, OPTIONS"
        );
        assert_eq!(
            pre.headers()["access-control-allow-headers"],
            "content-type"
        );

        let foreign = run(
            &mut f,
            req(
                "OPTIONS",
                "http://tlapi.localhost/api/rpc-call",
                Some("http://evil.example"),
                b"",
            ),
        );
        assert_eq!(foreign.status(), 403);
        assert_eq!(acao(&foreign), None);
        assert!(foreign
            .headers()
            .get("access-control-allow-methods")
            .is_none());
    }

    #[test]
    fn key_routes_are_refused_end_to_end() {
        let mut f = fixture();
        let r = run(
            &mut f,
            req(
                "POST",
                "http://tlapi.localhost/keys/new-wallet",
                Some(ALLOWED_ORIGIN),
                br#"{"network":"LTC"}"#,
            ),
        );
        assert_eq!(r.status(), 500);
        let text = String::from_utf8(r.body().clone()).unwrap();
        assert!(text.contains("key material stays out of the UI"));
        assert!(!text.contains("mnemonic"));
        assert!(json_of(&r).get("data").is_none());

        let mnemonic = ["abandon"; 12].join(" ");
        let r = run(
            &mut f,
            req(
                "POST",
                "http://tlapi.localhost/keys/get-address",
                Some(ALLOWED_ORIGIN),
                json!({"network":"LTC","mnemonic":mnemonic,"derivatePath":"m/84'/2'/0'/0/0"})
                    .to_string()
                    .as_bytes(),
            ),
        );
        assert_eq!(r.status(), 500);
        let v = json_of(&r);
        assert!(v.get("privkey").is_none() && v.get("wif").is_none());
        assert!(v["error"]
            .as_str()
            .unwrap()
            .contains("keys live in the node wallet"));

        let mut signer = NodeWalletSigner::new(NodeSlot::default());
        assert!(signer.sign_tx("LTC", "00", "w", &[]).is_err());
        assert!(signer.sign_psbt("LTC", "w", "00").is_err());
    }

    #[test]
    fn non_allowlisted_rpc_method_is_denied_before_any_node_io() {
        let mut f = fixture();
        f.store.0.borrow_mut().files.insert(
            "/ltc/litecoin.conf".into(),
            "rpcuser=u\nrpcpassword=p\nrpcport=9332\n".into(),
        );
        f.node.script("getblockchaininfo", json!({"chain":"main"}));
        f.node.script("dumpprivkey", json!("L1leak"));
        let started = run(
            &mut f,
            req(
                "POST",
                "http://tlapi.localhost/api/start-wallet-node",
                Some(ALLOWED_ORIGIN),
                br#"{"network":"LTC"}"#,
            ),
        );
        assert_eq!(started.status(), 200);
        assert!(f.svc.node_connected());

        for m in ["dumpprivkey", "stop", "walletpassphrase", "DUMPPRIVKEY"] {
            let r = run(
                &mut f,
                req(
                    "POST",
                    "http://tlapi.localhost/api/rpc-call",
                    Some(ALLOWED_ORIGIN),
                    json!({"method": m, "params": []}).to_string().as_bytes(),
                ),
            );
            assert_eq!(r.status(), 403, "{m}");
            assert!(!String::from_utf8_lossy(r.body()).contains("L1leak"));
        }
        assert_eq!(f.node.total_calls(), 0);

        let ok = run(
            &mut f,
            req(
                "POST",
                "http://tlapi.localhost/api/rpc-call",
                Some(ALLOWED_ORIGIN),
                br#"{"method":"getblockchaininfo","params":[]}"#,
            ),
        );
        assert_eq!(ok.status(), 200);
        assert_eq!(json_of(&ok)["data"]["chain"], "main");
        assert_eq!(f.node.total_calls(), 1);
    }

    #[test]
    fn the_thread_serves_requests_and_reports_config_errors() {
        let token = SessionToken::from_hex(TOKEN).unwrap();
        let t2 = token.clone();
        let bridge = Bridge::start(
            move || {
                Ok(WalletService::new(
                    gate(t2),
                    Box::new(RefuseKeys),
                    Box::new(NodeWalletSigner::new(NodeSlot::default())),
                    Box::new(MemStore::default()),
                    Box::new(MemConnector::default()),
                    Box::new(MemRelayer::default()),
                    vec![],
                    "/ltc".into(),
                ))
            },
            &token,
        )
        .unwrap();
        let (tx, rx) = mpsc::channel();
        bridge.submit(
            &req(
                "POST",
                "http://tlapi.localhost/keys/new-wallet",
                Some(ALLOWED_ORIGIN),
                br#"{"network":"LTC"}"#,
            ),
            Box::new(move |r| tx.send(r).unwrap()),
        );
        let r = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(r.status, 500);
        assert_eq!(r.allow_origin.as_deref(), Some(ALLOWED_ORIGIN));

        let broken = Bridge::start(|| Err("config: bad".into()), &token).unwrap();
        let (tx, rx) = mpsc::channel();
        broken.submit(
            &req("POST", "http://tlapi.localhost/api/rpc-call", None, b"{}"),
            Box::new(move |r| tx.send(r).unwrap()),
        );
        let r = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(r.status, 500);
        assert_eq!(r.body["error"], "config: bad");
    }

    fn probe_reply(status: u16, body: Value) -> Reply {
        Reply {
            status,
            body,
            allow_origin: None,
            preflight: false,
        }
    }

    #[test]
    fn probe_replies_map_to_node_states() {
        use socketio::Probe;
        let ok = probe_reply(
            200,
            json!({ "data": { "blocks": 12, "headers": 15, "chain": "main" } }),
        );
        assert_eq!(
            interpret_probe(&ok),
            Probe::Info {
                height: 12,
                headers: 15
            }
        );
        let no_headers = probe_reply(200, json!({ "data": { "blocks": 3 } }));
        assert_eq!(
            interpret_probe(&no_headers),
            Probe::Info {
                height: 3,
                headers: 3
            }
        );
        let odd = probe_reply(200, json!({ "data": {} }));
        assert!(matches!(interpret_probe(&odd), Probe::Error(_)));
        let none = probe_reply(500, json!({ "error": "No RPC Client initialized" }));
        assert_eq!(interpret_probe(&none), Probe::NotConnected);
        let down = probe_reply(
            500,
            json!({ "error": "request failed: connection refused" }),
        );
        assert_eq!(
            interpret_probe(&down),
            Probe::Error("request failed: connection refused".into())
        );
        assert_eq!(
            interpret_probe(&probe_reply(503, json!({ "error": "legacy bridge busy" }))),
            Probe::Skip
        );
        assert!(matches!(
            interpret_probe(&probe_reply(500, Value::Null)),
            Probe::Error(_)
        ));
    }

    fn wait<T>(rx: &mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(5)).unwrap()
    }

    fn dispatch_to(
        b: &Bridge,
        r: http::Request<Vec<u8>>,
    ) -> mpsc::Receiver<http::Response<Vec<u8>>> {
        let (tx, rx) = mpsc::channel();
        b.dispatch(r, Box::new(move |resp| tx.send(resp).unwrap()));
        rx
    }

    fn text_of(r: &http::Response<Vec<u8>>) -> String {
        String::from_utf8(r.body().clone()).unwrap()
    }

    #[test]
    fn the_bridge_serves_socket_io_and_block_events_from_the_node() {
        let token = SessionToken::from_hex(TOKEN).unwrap();
        let t2 = token.clone();
        let bridge = Bridge::start_with(
            move || {
                let conn = MemConnector::default();
                conn.node
                    .script("getblockchaininfo", json!({ "blocks": 42, "headers": 50 }));
                let store = MemStore::default();
                store.0.borrow_mut().files.insert(
                    "/ltc/litecoin.conf".into(),
                    "rpcuser=u\nrpcpassword=p\nrpcport=9332\n".into(),
                );
                Ok(WalletService::new(
                    gate(t2),
                    Box::new(RefuseKeys),
                    Box::new(NodeWalletSigner::new(NodeSlot::default())),
                    Box::new(store),
                    Box::new(conn),
                    Box::new(MemRelayer::default()),
                    vec![],
                    "/ltc".into(),
                ))
            },
            &token,
            socketio::Config {
                ping_interval_ms: 150,
                ping_timeout_ms: 100,
                probe_interval_ms: 20,
            },
        )
        .unwrap();
        let base = "http://tlapi.localhost/socket.io/?EIO=4&transport=polling";
        let get = |url: &str| {
            wait(&dispatch_to(
                &bridge,
                req("GET", url, Some(ALLOWED_ORIGIN), b""),
            ))
        };
        let open = get(base);
        assert_eq!(open.status(), 200);
        assert_eq!(acao(&open), Some(ALLOWED_ORIGIN));
        let sid = serde_json::from_str::<Value>(&text_of(&open)[1..]).unwrap()["sid"]
            .as_str()
            .unwrap()
            .to_string();
        let url = format!("{base}&sid={sid}");
        let post = wait(&dispatch_to(
            &bridge,
            req("POST", &url, Some(ALLOWED_ORIGIN), b"40"),
        ));
        assert_eq!(text_of(&post), "ok");
        assert!(text_of(&get(&url)).starts_with("40{"));
        // No node started yet: the poll only pings.
        assert_eq!(text_of(&get(&url)), "2");
        // Start the node through the JSON API; a block then arrives as a socket event.
        let start = wait(&dispatch_to(
            &bridge,
            req(
                "POST",
                "http://tlapi.localhost/api/start-wallet-node",
                Some(ALLOWED_ORIGIN),
                br#"{"network":"LTC"}"#,
            ),
        ));
        assert_eq!(start.status(), 200, "{}", text_of(&start));
        let mut seen = String::new();
        for _ in 0..40 {
            seen = text_of(&get(&url));
            if seen.contains("new-block") {
                break;
            }
        }
        assert_eq!(seen, r#"42["new-block",{"height":42,"header":50}]"#);
        // The JSON path is unaffected by the socket.io session.
        let r = get("http://tlapi.localhost/nope");
        assert_eq!(r.status(), 405);
    }

    #[test]
    fn default_node_dir_is_the_platform_litecoin_dir() {
        let d = default_node_dir(Path::new("/roaming"), Path::new("/home/u"));
        if cfg!(any(windows, target_os = "macos")) {
            assert_eq!(d, Path::new("/roaming").join("Litecoin"));
        } else {
            assert_eq!(d, Path::new("/home/u").join(".litecoin"));
        }
    }

    // ---- config store

    fn scratch(name: &str) -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("tl-legacy-{name}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        std::fs::canonicalize(p).unwrap()
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn conf_store_refuses_paths_outside_the_data_dir() {
        let base = scratch("store");
        let root = base.join("node");
        let other = base.join("other");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join(CONF_NAME), "rpcuser=secret\n").unwrap();
        std::fs::write(base.join("secret.txt"), "x").unwrap();
        let mut st = FsConfStore::new(root.clone());

        assert!(st.dir_exists(&s(&root)));
        assert!(!st.dir_exists(&s(&other)));
        assert!(!st.dir_exists(&format!("{}/../other", s(&root))));
        assert!(!st.dir_exists("relative/dir"));
        assert!(!st.dir_exists(""));

        let escaped = format!("{}/../other/{CONF_NAME}", s(&root));
        assert_eq!(st.read(&escaped), None);
        assert_eq!(st.read(&s(&other.join(CONF_NAME))), None);
        assert!(!st.file_exists(&s(&other.join(CONF_NAME))));
        assert!(st.write_new(&escaped, "x").is_err());
        assert!(st.write_new(&s(&other.join("new.conf")), "x").is_err());
        assert!(st.write_new(CONF_NAME, "x").is_err());
        // Inside the directory, only litecoin.conf may be created or read.
        assert!(st.write_new(&s(&root.join("wallet.dat")), "x").is_err());
        std::fs::write(root.join("wallet.dat"), "x").unwrap();
        assert_eq!(st.read(&s(&root.join("wallet.dat"))), None);
        assert!(!other.join("new.conf").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn conf_store_creates_new_files_only_and_bounds_reads() {
        let root = scratch("conf");
        let mut st = FsConfStore::new(root.clone());
        let conf = format!("{}/{CONF_NAME}", s(&root));
        assert!(!st.file_exists(&conf));
        st.write_new(&conf, "rpcuser=u\nrpcpassword=p\n").unwrap();
        assert!(st.file_exists(&conf));
        assert_eq!(
            st.read(&conf).as_deref(),
            Some("rpcuser=u\nrpcpassword=p\n")
        );
        assert!(st.write_new(&conf, "other").is_err());
        assert_eq!(
            st.read(&conf).as_deref(),
            Some("rpcuser=u\nrpcpassword=p\n")
        );

        std::fs::write(
            root.join(CONF_NAME),
            vec![b'a'; MAX_CONF_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(st.read(&conf), None);
        std::fs::write(root.join(CONF_NAME), vec![b'a'; MAX_CONF_BYTES as usize]).unwrap();
        assert_eq!(
            st.read(&conf).map(|t| t.len()),
            Some(MAX_CONF_BYTES as usize)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn conf_store_without_a_root_directory_refuses_everything() {
        let base = scratch("noroot");
        let st = FsConfStore::new(base.join("missing"));
        assert!(!st.dir_exists(&s(&base)));
        assert!(!st.dir_exists(&s(&base.join("missing"))));
        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- JSON-RPC client against a mock HTTP server

    fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = stream.read(&mut chunk).unwrap_or(0);
            if n == 0 {
                return buf;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(h) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..h]).to_ascii_lowercase();
                let len = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if buf.len() >= h + 4 + len {
                    return buf;
                }
            }
        }
    }

    /// Serve one connection with a canned response; the thread returns the raw request.
    fn mock_server(response: Vec<u8>) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut st, _) = l.accept().unwrap();
            let req = read_request(&mut st);
            // The client may hang up early (oversized response): ignore write errors.
            let _ = st.write_all(&response);
            let _ = st.flush();
            req
        });
        (port, h)
    }

    fn http_response(status: &str, body: &[u8]) -> Vec<u8> {
        let mut v = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn rpc_client_success_sends_json_rpc_1_0_with_basic_auth() {
        let (port, h) = mock_server(http_response(
            "200 OK",
            br#"{"result":{"chain":"main","blocks":7},"error":null,"id":1}"#,
        ));
        let mut c = RpcClient::new(&format!("http://127.0.0.1:{port}/"), "user", "pw").unwrap();
        let r = c
            .call("getblockchaininfo", &[json!(1), json!("a")])
            .unwrap();
        assert_eq!(r["blocks"], 7);
        let raw = String::from_utf8(h.join().unwrap()).unwrap();
        let lower = raw.to_ascii_lowercase();
        assert!(lower.starts_with("post / http/1.1"));
        assert!(lower.contains("authorization: basic dxnlcjpwdw=="));
        assert!(lower.contains("content-type: application/json"));
        let body: Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"jsonrpc":"1.0","id":1,"method":"getblockchaininfo","params":[1,"a"]})
        );
    }

    #[test]
    fn rpc_client_pins_localhost_to_loopback() {
        let (port, h) = mock_server(http_response(
            "200 OK",
            br#"{"result":"ok","error":null,"id":1}"#,
        ));
        let mut c = RpcClient::new(&format!("http://localhost:{port}/"), "u", "p").unwrap();
        assert_eq!(c.call("getnewaddress", &[]).unwrap(), json!("ok"));
        h.join().unwrap();
    }

    #[test]
    fn rpc_client_maps_rpc_errors_to_messages() {
        let (port, h) = mock_server(http_response(
            "500 Internal Server Error",
            br#"{"result":null,"error":{"code":-32601,"message":"Method not found"},"id":1}"#,
        ));
        let mut c = RpcClient::new(&format!("http://127.0.0.1:{port}/"), "u", "p").unwrap();
        assert_eq!(c.call("nope", &[]).unwrap_err(), "Method not found");
        h.join().unwrap();

        let (port, h) = mock_server(http_response("401 Unauthorized", b""));
        let mut c = RpcClient::new(&format!("http://127.0.0.1:{port}/"), "u", "p").unwrap();
        assert_eq!(
            c.call("getblockchaininfo", &[]).unwrap_err(),
            "node returned HTTP 401"
        );
        h.join().unwrap();

        assert_eq!(
            interpret_rpc(200, b"not json").unwrap_err(),
            "node returned invalid JSON"
        );
        assert_eq!(
            interpret_rpc(200, br#"{"error":null}"#).unwrap(),
            Value::Null
        );
    }

    #[test]
    fn rpc_client_caps_the_response() {
        // Declared length over the cap.
        let (port, h) = mock_server(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_RESPONSE_BYTES + 1
            )
            .into_bytes(),
        );
        let mut c = RpcClient::new(&format!("http://127.0.0.1:{port}/"), "u", "p").unwrap();
        assert_eq!(
            c.call("getblockchaininfo", &[]).unwrap_err(),
            "response too large"
        );
        h.join().unwrap();

        // No length at all: the bounded reader stops at the cap.
        let mut body = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        body.extend(std::iter::repeat_n(b'a', MAX_RESPONSE_BYTES + 1024));
        let (port, h) = mock_server(body);
        let mut c = RpcClient::new(&format!("http://127.0.0.1:{port}/"), "u", "p").unwrap();
        assert_eq!(
            c.call("getblockchaininfo", &[]).unwrap_err(),
            "response too large"
        );
        h.join().unwrap();

        assert_eq!(
            read_bounded(Cursor::new(vec![0u8; 10]), 10).unwrap().len(),
            10
        );
        assert!(read_bounded(Cursor::new(vec![0u8; 11]), 10).is_err());
    }

    #[test]
    fn rpc_client_refuses_remote_http_and_odd_urls() {
        for u in [
            "http://example.com:8332/",
            "http://192.0.2.1:8332/",
            "http://10.0.0.1:8332/",
            "ftp://127.0.0.1/",
            "http://u:p@127.0.0.1:8332/",
            "http://127.0.0.1:8332/?a=1",
            "not a url",
        ] {
            assert!(RpcClient::new(u, "u", "p").is_err(), "{u}");
        }
        assert!(RpcClient::new("http://127.0.0.1:8332/", "u", "p").is_ok());
        assert!(RpcClient::new("http://[::1]:8332/", "u", "p").is_ok());
        assert!(RpcClient::new("https://node.example:8332/", "u", "p").is_ok());
    }

    #[test]
    fn connector_builds_a_client_for_loopback_endpoints() {
        let ep = RpcEndpoint {
            user: "u".into(),
            password: "p".into(),
            host: "::1".into(),
            port: 9332,
        };
        assert!(HttpConnector.connect(&ep, false).is_ok());
        let remote = RpcEndpoint {
            host: "example.com".into(),
            ..ep
        };
        assert!(HttpConnector.connect(&remote, false).is_err());
    }

    // ---- relayer

    #[test]
    fn relayer_is_https_only_and_unwraps_the_envelope() {
        let mut r = HttpRelayer::new().unwrap();
        for base in ["http://127.0.0.1:1", "http://relayer.example", "ftp://x"] {
            let e = r.call(base, "validateaddress", &[json!("a")]).unwrap_err();
            assert!(e.contains("scheme") || e.contains("URL"), "{base}: {e}");
        }
        assert!(r
            .call("https://relayer.example", "bad/method", &[])
            .is_err());
        assert!(r.call("https://relayer.example", "", &[]).is_err());

        assert_eq!(
            interpret_relayer(200, br#"{"data":{"isvalid":true}}"#).unwrap(),
            json!({"isvalid": true})
        );
        assert_eq!(
            interpret_relayer(500, br#"{"error":"boom"}"#).unwrap_err(),
            "boom"
        );
        assert_eq!(
            interpret_relayer(403, br#"{"error":{"code":"X","message":"no"}}"#).unwrap_err(),
            "no"
        );
        assert!(interpret_relayer(200, br#"{"x":1}"#).is_err());
        assert!(interpret_relayer(502, b"<html>").is_err());
    }

    #[test]
    fn rpc_errors_keep_the_node_code_for_rpc_call() {
        let body = br#"{"result":null,"error":{"code":-18,"message":"Requested wallet does not exist or is not loaded"},"id":1}"#;
        assert_eq!(
            interpret_rpc_detailed(500, body),
            RpcOutcome::RpcError {
                code: -18,
                message: "Requested wallet does not exist or is not loaded".into()
            }
        );
        assert_eq!(
            interpret_rpc_detailed(
                200,
                br#"{"result":{"chain":"regtest"},"error":null,"id":2}"#
            ),
            RpcOutcome::Ok(json!({"chain": "regtest"}))
        );
        assert!(matches!(
            interpret_rpc_detailed(502, b"bad gateway"),
            RpcOutcome::Failed(_)
        ));
    }

    #[test]
    fn tl_api_route_answers_the_bare_result_through_the_gate() {
        let mut f = fixture();
        f.store.0.borrow_mut().files.insert(
            "/ltc/litecoin.conf".into(),
            "rpcuser=u
rpcpassword=p
rpcport=9332
"
            .into(),
        );
        let started = run(
            &mut f,
            req(
                "POST",
                "http://tlapi.localhost/api/start-wallet-node",
                Some(ALLOWED_ORIGIN),
                br#"{"network":"LTCTEST"}"#,
            ),
        );
        assert_eq!(started.status(), 200);
        let rows = json!([{"propertyId": "5", "amount": 3, "available": 3, "reserved": "0"}]);
        f.node.script("tl_getallbalancesforaddress", rows.clone());
        f.node.script("dumpprivkey", json!("L1leak"));
        // balance.service passes the address as a bare string, not an array.
        let r = run(
            &mut f,
            req(
                "POST",
                "http://tlapi.localhost/tl/tl_getallbalancesforaddress",
                Some(ALLOWED_ORIGIN),
                br#"{"params":"bcrt1qexample"}"#,
            ),
        );
        assert_eq!(r.status(), 200);
        assert_eq!(json_of(&r), rows);
        assert_eq!(acao(&r), Some(ALLOWED_ORIGIN));
        let calls = f.node.0.borrow().calls.clone();
        assert_eq!(
            calls.last().unwrap(),
            &(
                "tl_getallbalancesforaddress".to_string(),
                vec![json!("bcrt1qexample")]
            )
        );
        // Same allowlist as rpc-call.
        let denied = run(
            &mut f,
            req(
                "POST",
                "http://tlapi.localhost/tl/dumpprivkey",
                Some(ALLOWED_ORIGIN),
                br#"{"params":["a"]}"#,
            ),
        );
        assert_eq!(denied.status(), 403);
        assert_eq!(f.node.calls_of("dumpprivkey"), 0);
        // A node error is an HTTP error for the TL API client.
        f.node
            .script_error("tl_getproperty", -8, "Property not found");
        let err = run(
            &mut f,
            req(
                "POST",
                "http://tlapi.localhost/tl/tl_getproperty",
                Some(ALLOWED_ORIGIN),
                br#"{"params":[99]}"#,
            ),
        );
        assert_eq!(err.status(), 500);
        assert_eq!(json_of(&err)["EECode"], json!(-8));
    }
}
