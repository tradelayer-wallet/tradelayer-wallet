//! The routes FE-speed's UI calls beyond the 2024 table: the TradeLayer listener passthrough
//! (`/tlraw/*`), FE-speed's `/tl/*` routes (`routes/tradelayer.route.ts`), the `/api/*`
//! additions (`routes/main.route.ts`), `rpc-call` with wallet routing and transient-error
//! semantics, and the non-blocking `start-wallet-node`.
//!
//! The TradeLayer listener is reached through [`ListenerBackend`]; this module owns no sockets.
//! Every route here runs behind the gate like the rest of the service.
//!
//! Deliberate differences from FE-speed (each one makes a route answer where FE-speed hangs or
//! fails for the UI's own request):
//!
//! * `/tl/getChannel` accepts the `{params:[address]}` body the UI sends as well as FE-speed's
//!   bare `[address]` (FE-speed's handler throws on the UI's body).
//! * `/tl/init` called again after a successful init answers 200 (FE-speed never replies), and
//!   `/tl/getMaxParsedHeight` and `/tl/getAttestations` answer 500 on error (FE-speed swallows the
//!   error and never replies).
//! * `rpc-call` of a locally encoded `tl_createpayload_*` answers `{data: <payload>}`, the shape
//!   every caller reads; FE-speed sends the bare string, which the UI cannot parse as JSON.
//! * No `exponential-backoff` retry loop around `rpc-call`: the service thread must not sleep.
//!   The UI polls, and a transient failure answers `200 {error}` at once.
//! * `/api/tradelayer/*` never spawns a Node child; `init-tradelayer` and `sync-status` report
//!   whether the configured listener answers.

use super::{
    fail, ok, req_str, HttpRequest, ListenerReply, RpcBackend, WalletService, MAX_BODY_BYTES,
};
use crate::jsval::{encode_uri_component, js_string, nullish, to_number, truthy};
use crate::multisig::compute_multisig;
use crate::nodecfg::{is_testnet, launch_args, parse_conf, rpc_endpoint, LaunchOptions};
use crate::service::RpcOutcome;
use crate::tlpayload::build_payload;
use serde_json::{json, Map, Value};
use std::time::Duration;

/// Listener calls that stand for a UI action (60 s, as FE-speed's `rpc-proxy`).
const LISTENER_TIMEOUT: Duration = Duration::from_secs(60);
/// Status probes: short, because the service thread is blocked while one runs.
const STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const REACH_TIMEOUT: Duration = Duration::from_secs(3);
/// `tl_initmain` inside `sync-status` (FE-speed allows 60 s; the service thread cannot wait that
/// long for a poll).
const INIT_TIMEOUT: Duration = Duration::from_secs(15);
/// Pending-attach polls (one per second) before the node connection is given up on.
const MAX_PENDING_POLLS: u32 = 600;
const MAX_QUERY_BYTES: usize = 2048;
const MAX_COLLATOR_URLS: usize = 32;

pub const UNAVAILABLE: &str = "not available in the desktop build";
const NO_LISTENER: &str = "TradeLayer listener is not configured";

/// Listener endpoints the page may reach through `/tlraw/<name>`: those FE-speed's UI calls on
/// `http://localhost:3000` (porting map 1.8), with the verb the UI uses.
pub const TLRAW_POST: &[&str] = &[
    "tl_initmain",
    "tl_getSyncStatus",
    "tl_getMaxParsedHeight",
    "tl_getMaxProcessedHeight",
    "tl_getTrackHeight",
    "tl_checkSync",
    "tl_loadWallet",
    "tl_getStateSnapshot",
    "tl_getAllBalancesForAddress",
    "tl_getChannel",
    "tl_getChannelColumn",
    "tl_listProperties",
    "tl_getProperty",
    "tl_getAttestations",
    "tl_getTransaction",
    "tl_getClearlistById",
    "tl_listContractSeries",
    "tl_watchonly_register",
    "tl_watchonly_utxos",
];

pub const TLRAW_GET: &[&str] = &[
    "tl_contractPosition",
    "tl_getContractInfo",
    "tl_getInitMargin",
    "tl_channelBalanceForCommiter",
    "tl_getMaxSynth",
    "tl_tokenTradeHistoryForAddress",
    "tl_contractTradeHistoryForAddress",
    "tl_totalTradeHistoryForAddress",
    "tl_contractTradeHistory",
    "tl_fundingHistory",
    "tl_oracleHistory",
];

/// FE-speed's `/tl/<name>` routes (exact, case-sensitive).
pub const TL_ROUTES: &[&str] = &[
    "init",
    "getAllBalancesForAddress",
    "getChannel",
    "test",
    "getChannelColumn",
    "listProperties",
    "getProperty",
    "getMaxProcessedHeight",
    "getMaxParsedHeight",
    "contractPosition",
    "loadWallet",
    "stateSnapshot",
    "getAttestations",
];

/// Core RPC methods FE-speed sends to `/wallet/<name>` when a wallet label is given
/// (`WALLET_RPC_METHODS` in `rpc-proxy.service.ts`).
const WALLET_METHODS: &[&str] = &[
    "createwallet",
    "loadwallet",
    "listwallets",
    "getwalletinfo",
    "getaddressesbylabel",
    "getnewaddress",
    "getrawchangeaddress",
    "getbalances",
    "getbalance",
    "getunconfirmedbalance",
    "getreceivedbylabel",
    "dumpprivkey",
    "importaddress",
    "importpubkey",
    "importmulti",
    "setlabel",
    "listlabels",
    "getaddressinfo",
    "listunspent",
    "signrawtransactionwithwallet",
    "walletpassphrase",
    "walletlock",
    "encryptwallet",
    "walletcreatefundedpsbt",
    "walletprocesspsbt",
    "backupwallet",
    "dumpwallet",
    "bumpfee",
];

/// True for FE-speed's `/tl/<name>` routes: the bridge serves those here and every other
/// `/tl/<method>` as a node `rpc-call` of `<method>` (the 2024 mapping).
pub fn is_tl_route(name: &str) -> bool {
    TL_ROUTES.contains(&name)
}

/// Core's start-up and connection-loss messages (FE-speed's `isTransientRpcStartupError` plus
/// the start-wallet-node probe's own list).
pub fn is_transient(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    [
        "econnrefused",
        "connection refused",
        "actively refused",
        "socket hang up",
        "etimedout",
        "timed out",
        "econnreset",
        "connection reset",
        "loading block index",
        "rewinding blocks",
        "verifying blocks",
        "warming up",
        "work queue depth exceeded",
    ]
    .iter()
    .any(|t| m.contains(t))
}

fn is_auth_error(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    [
        "401",
        "unauthorized",
        "forbidden",
        "incorrect rpcuser",
        "incorrect rpcpassword",
        "authorization failed",
        "authentication failed",
    ]
    .iter()
    .any(|t| m.contains(t))
}

/// Answer for a pending (not yet answering) node connection.
const STARTING_MESSAGE: &str = "Loading block index...";

fn tl_error(e: impl std::fmt::Display) -> (u16, Value) {
    (500, Value::String(format!("Error: {e}")))
}

fn or_value(v: Value, fallback: Value) -> Value {
    if truthy(&v) {
        v
    } else {
        fallback
    }
}

fn valid_query(q: &str) -> bool {
    q.len() <= MAX_QUERY_BYTES
        && q.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'-' | b'.'
                        | b'_'
                        | b'~'
                        | b'%'
                        | b'!'
                        | b'$'
                        | b'&'
                        | b'\''
                        | b'('
                        | b')'
                        | b'*'
                        | b'+'
                        | b','
                        | b';'
                        | b'='
                        | b':'
                        | b'@'
                        | b'/'
                        | b'?'
                )
        })
}

impl WalletService {
    /// Install the TradeLayer listener client. Without one every listener route answers its
    /// listener-down error.
    pub fn set_listener(&mut self, listener: Box<dyn super::ListenerBackend>) {
        self.listener = Some(listener);
    }

    /// With this on, `rpc-call` of a `tl_*` method is answered as FE-speed's wallet-server does:
    /// the seven local encoders, any other `tl_*` through the listener. Off (default), `tl_*`
    /// goes to the node like every other method, as the 2024 UI expects.
    pub fn set_tl_rpc_via_listener(&mut self, on: bool) {
        self.tl_rpc_via_listener = on;
    }

    /// The `allowRescan` flag of the last `start-wallet-node` (FE-speed's
    /// `WATCHONLY_RESCAN_OPT_IN`).
    pub fn rescan_opt_in(&self) -> bool {
        self.rescan_opt_in
    }

    pub fn has_pending_node(&self) -> bool {
        self.pending.is_some()
    }

    /// Retry a node that was still starting when `start-wallet-node` ran. Call about once a
    /// second; the service never sleeps or spawns a thread itself.
    pub fn poll_pending_node(&mut self) {
        let Some(mut client) = self.pending.take() else {
            return;
        };
        self.pending_polls += 1;
        match probe_node(client.as_mut()) {
            Probe::Ready => self.node = Some(client),
            Probe::Starting(_) if self.pending_polls < MAX_PENDING_POLLS => {
                self.pending = Some(client)
            }
            _ => {}
        }
    }

    // ------------------------------------------------------------------ listener plumbing

    fn listener_call(
        &mut self,
        method: &str,
        endpoint: &str,
        query: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<ListenerReply, String> {
        match self.listener.as_mut() {
            Some(l) => l.request(method, endpoint, query, body, timeout),
            None => Err(NO_LISTENER.into()),
        }
    }

    /// axios semantics: the body for a 2xx, an error for anything else.
    fn listener_data(
        &mut self,
        method: &str,
        endpoint: &str,
        query: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let r = self.listener_call(method, endpoint, query, body, timeout)?;
        if (200..300).contains(&r.status) {
            Ok(r.body)
        } else {
            Err(format!("Request failed with status code {}", r.status))
        }
    }

    fn listener_origin(&self) -> String {
        self.listener
            .as_ref()
            .map(|l| l.origin())
            .unwrap_or_default()
    }

    /// Any 2xx answer means the listener is up (FE-speed's `listenerReachable`).
    fn listener_reachable(&mut self, timeout: Duration) -> bool {
        self.listener_data("POST", "tl_getSyncStatus", "", Some(&json!({})), timeout)
            .is_ok()
    }

    // ------------------------------------------------------------------ dispatch

    /// Routes of this module. `None` means the path is not one of them.
    pub(super) fn fespeed_dispatch(&mut self, req: &HttpRequest) -> Option<(u16, Value)> {
        let path = req.path.as_str();
        let method = req.method.as_str();
        let too_big = req.body_len > MAX_BODY_BYTES;
        if let Some(name) = path.strip_prefix("/tlraw/") {
            if too_big {
                return Some(fail(413, "body too large"));
            }
            return Some(self.tlraw(method, name, req.query.as_str(), &req.body));
        }
        if let Some(name) = path.strip_prefix("/tl/") {
            if !is_tl_route(name) {
                return None;
            }
            if method != "POST" {
                return Some(fail(405, "method not allowed"));
            }
            if too_big {
                return Some(fail(413, "body too large"));
            }
            return self.tl_route(name, &req.body);
        }
        match path {
            "/api/tradelayer/sync-status" => {
                return Some(if method == "GET" {
                    ok(self.tl_sync_status())
                } else {
                    fail(405, "method not allowed")
                })
            }
            "/api/tradelayer/collator-status" => {
                return Some(if method == "GET" {
                    ok(self.collator_status())
                } else {
                    fail(405, "method not allowed")
                })
            }
            "/api/compute-multisig"
            | "/api/init-tradelayer"
            | "/api/tradelayer/set-collator-config" => {
                if method != "POST" {
                    return Some(fail(405, "method not allowed"));
                }
                if too_big {
                    return Some(fail(413, "body too large"));
                }
                let r = match path {
                    "/api/compute-multisig" => self.compute_multisig_route(&req.body),
                    "/api/init-tradelayer" => self.init_tradelayer(),
                    _ => self.set_collator_config(&req.body),
                };
                return Some(r.unwrap_or_else(|e| fail(500, e)));
            }
            _ => {}
        }
        if is_unavailable(path) {
            return Some(fail(503, UNAVAILABLE));
        }
        None
    }

    // ------------------------------------------------------------------ /tlraw/

    /// Forward one request to the listener, verbatim: the verb and endpoint must be on the
    /// allowlist, the body is the page's JSON, the query is passed through after a character
    /// check, and the listener's status and JSON body come back as they are. A listener that
    /// cannot be reached, answers too slowly or too much is a 502.
    fn tlraw(&mut self, method: &str, name: &str, query: &str, body: &Value) -> (u16, Value) {
        let verb = if TLRAW_POST.contains(&name) {
            "POST"
        } else if TLRAW_GET.contains(&name) {
            "GET"
        } else {
            return fail(404, "not found");
        };
        if method != verb {
            return fail(405, "method not allowed");
        }
        if !valid_query(query) {
            return fail(400, "query malformed");
        }
        let b = if verb == "POST" && !body.is_null() {
            Some(body)
        } else {
            None
        };
        match self.listener_call(verb, name, query, b, LISTENER_TIMEOUT) {
            Ok(r) => (r.status, r.body),
            Err(e) => fail(502, e),
        }
    }

    // ------------------------------------------------------------------ /tl/<route>

    fn tl_route(&mut self, name: &str, b: &Value) -> Option<(u16, Value)> {
        let params = b.get("params");
        let r: (u16, Value) = match name {
            "init" => self.tl_init(),
            "test" => (200, json!({ "message": "Test route working" })),
            "getAllBalancesForAddress" => {
                let address = match params {
                    Some(Value::Array(a)) => a.first(),
                    _ => {
                        return Some(tl_error(
                            "Cannot read properties of undefined (reading '0')",
                        ))
                    }
                };
                let body = match address {
                    Some(a) => json!({ "params": a }),
                    None => json!({}),
                };
                self.tl_forward("tl_getAllBalancesForAddress", &body, |d| d)
            }
            "getChannel" => {
                let address = match (b, params) {
                    (Value::Array(a), _) => a.first(),
                    (_, Some(Value::Array(a))) => a.first(),
                    (_, Some(v)) => Some(v),
                    _ => None,
                };
                let body = match address {
                    Some(a) => json!({ "params": a }),
                    None => json!({}),
                };
                self.tl_forward("tl_getChannel", &body, |d| d)
            }
            "getChannelColumn" => {
                let list: &[Value] = match (b, params) {
                    (Value::Array(a), _) => a,
                    (_, Some(Value::Array(a))) => a,
                    _ => &[],
                };
                let pick = |keys: &[&str], idx: usize| -> Option<Value> {
                    for k in keys {
                        if let Some(v) = b.get(*k) {
                            if truthy(v) {
                                return Some(v.clone());
                            }
                        }
                    }
                    list.get(idx).filter(|v| truthy(v)).cloned()
                };
                let channel = pick(&["channelAddress", "channel"], 0);
                let commit = pick(
                    &["newCommitAddress", "myAddress", "myAddr", "buyerAddress"],
                    1,
                );
                let cp = pick(&["cpAddress", "cpAddr"], 2);
                let (Some(channel), Some(commit), Some(cp)) = (channel, commit, cp) else {
                    return Some((
                        400,
                        Value::String(
                            "channelAddress, newCommitAddress, and cpAddress are required".into(),
                        ),
                    ));
                };
                let body = json!({
                    "channelAddress": channel,
                    "newCommitAddress": commit,
                    "cpAddress": cp,
                });
                self.tl_forward("tl_getChannelColumn", &body, |d| d)
            }
            "listProperties" => self.tl_forward("tl_listProperties", &Value::Null, |d| {
                or_value(d, json!([]))
            }),
            "getProperty" => {
                let id = match params {
                    Some(Value::Array(a)) => a.first().cloned(),
                    Some(v) => Some(v.clone()),
                    None => None,
                };
                let body = match id {
                    Some(v) => json!({ "params": v }),
                    None => json!({}),
                };
                self.tl_forward("tl_getProperty", &body, |d| or_value(d, Value::Null))
            }
            "getMaxProcessedHeight" => {
                self.tl_forward("tl_getMaxProcessedHeight", &Value::Null, |d| {
                    or_value(d, json!(0))
                })
            }
            "getMaxParsedHeight" => self.tl_forward("tl_getMaxParsedHeight", &Value::Null, |d| {
                or_value(d, json!(0))
            }),
            "contractPosition" => {
                let p = match params {
                    Some(p @ Value::Object(_)) => p,
                    _ => {
                        return Some((
                            500,
                            json!({ "error": "Cannot destructure property 'address' of 'params' as it is undefined." }),
                        ))
                    }
                };
                let part = |k: &str| match p.get(k) {
                    Some(v) => encode_uri_component(&js_string(v)),
                    None => "undefined".to_string(),
                };
                let query = format!(
                    "address={}&contractId={}",
                    part("address"),
                    part("contractId")
                );
                match self.listener_data(
                    "GET",
                    "tl_contractPosition",
                    &query,
                    None,
                    LISTENER_TIMEOUT,
                ) {
                    Ok(d) => (200, d),
                    Err(e) => (500, json!({ "error": e })),
                }
            }
            "loadWallet" => {
                self.tl_forward("tl_loadWallet", &Value::Null, |d| or_value(d, json!(0)))
            }
            "stateSnapshot" => {
                let label = match b.get("label") {
                    Some(v) if truthy(v) => js_string(v).trim().to_string(),
                    _ => String::new(),
                };
                let label = if label.is_empty() {
                    "TL".to_string()
                } else {
                    label
                };
                self.tl_forward("tl_getStateSnapshot", &json!({ "label": label }), |d| {
                    or_value(d, json!({}))
                })
            }
            "getAttestations" => {
                let (address, id) = match params {
                    Some(Value::Array(a)) => (a.first(), a.get(1)),
                    _ => {
                        return Some(tl_error(
                            "Cannot read properties of undefined (reading 'params')",
                        ))
                    }
                };
                let mut m = Map::new();
                if let Some(a) = address {
                    m.insert("address".into(), a.clone());
                }
                if let Some(i) = id {
                    m.insert("id".into(), i.clone());
                }
                self.tl_forward("tl_getAttestations", &Value::Object(m), |d| {
                    or_value(d, json!([]))
                })
            }
            _ => return None,
        };
        Some(r)
    }

    /// POST to a listener endpoint; 200 with `shape(body)`, or FE-speed's `'Error: ' + message`.
    fn tl_forward(
        &mut self,
        endpoint: &str,
        body: &Value,
        shape: impl FnOnce(Value) -> Value,
    ) -> (u16, Value) {
        let b = if body.is_null() { None } else { Some(body) };
        match self.listener_data("POST", endpoint, "", b, LISTENER_TIMEOUT) {
            Ok(d) => (200, shape(d)),
            Err(e) => tl_error(e),
        }
    }

    fn tl_init(&mut self) -> (u16, Value) {
        if self.tl_main_init {
            return (200, json!({ "message": "TL Main already initialized" }));
        }
        match self.listener_data(
            "POST",
            "tl_initmain",
            "",
            Some(&json!({ "wallet": true })),
            LISTENER_TIMEOUT,
        ) {
            Ok(d) => {
                if let Some(e) = d.get("error").filter(|e| truthy(e)) {
                    return (500, json!({ "error": js_string(e) }));
                }
                self.tl_main_init = true;
                (
                    200,
                    json!({ "message": "TL Main initialized successfully" }),
                )
            }
            Err(e) => (500, json!({ "error": e })),
        }
    }

    // ------------------------------------------------------------------ /api additions

    fn compute_multisig_route(&mut self, b: &Value) -> Result<(u16, Value), String> {
        let network = b
            .get("network")
            .and_then(Value::as_str)
            .unwrap_or("undefined");
        Ok(ok(compute_multisig(b.get("m"), b.get("pubKeys"), network)?))
    }

    fn init_tradelayer(&mut self) -> Result<(u16, Value), String> {
        if self.listener_reachable(REACH_TIMEOUT) {
            Ok((200, json!({ "success": true, "result": true })))
        } else {
            Err(format!(
                "TradeLayer listener did not become reachable at {}",
                self.listener_origin()
            ))
        }
    }

    fn collator_status(&mut self) -> Value {
        let network = match self.network_label.as_deref() {
            Some("LTCTEST") => "litecoin.testnet",
            Some("LTC") => "litecoin.mainnet",
            _ => "",
        };
        json!({
            "autoContributeEnabled": false,
            "listenerUrl": self.listener_origin(),
            "walletRpcUrl": "",
            "collatorUrls": self.collator_urls,
            "activePeers": [],
            "peers": [],
            "shouldContributeReason": "collator peers are not available in the desktop build",
            "activePeerCount": 0,
            "rpcService": "tradelayer.rpc",
            "rpcNetwork": network,
            "rpcNodeId": "",
            "advertisedMethods": [],
            "retry": {
                "peerRetryCooldownMs": 15000,
                "registryGraceMs": 5000,
                "registryCheckIntervalMs": 5000,
                "advertiseIntervalMs": 5000,
                "healthMonitorIntervalMs": 5000,
                "cleanExitRecoveryDelayMs": 2000,
            },
            "lastSyncAt": null,
            "wsRelay": null,
        })
    }

    fn set_collator_config(&mut self, b: &Value) -> Result<(u16, Value), String> {
        let raw: Vec<String> = match b.get("collatorUrls") {
            Some(Value::Array(a)) => a.iter().map(js_string).collect(),
            Some(Value::String(s)) => s
                .split(['\n', ','])
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect(),
            _ => Vec::new(),
        };
        let mut urls: Vec<String> = Vec::new();
        for u in raw.into_iter().filter(|u| !u.is_empty()) {
            if u.len() > 512 || u.chars().any(|c| c.is_control() || c.is_whitespace()) {
                return Err("collator URL malformed".into());
            }
            if !urls.contains(&u) {
                urls.push(u);
            }
        }
        if urls.len() > MAX_COLLATOR_URLS {
            return Err("too many collator URLs".into());
        }
        self.collator_urls = urls.clone();
        // The collator peer needs FE-speed's Node child; the desktop build records the URLs for
        // the status page and never contributes.
        Ok(ok(
            json!({ "collatorUrls": urls, "autoContributeEnabled": false }),
        ))
    }

    // ------------------------------------------------------------------ sync status

    fn node_block_state(&mut self) -> (Option<u64>, Option<u64>) {
        if !matches!(self.ensure_node(), NodeState::Ready) {
            return (None, None);
        }
        let Some(node) = self.node.as_mut() else {
            return (None, None);
        };
        match node.call("getblockchaininfo", &[]) {
            Ok(v) => (
                normalize_height(v.get("blocks")),
                normalize_height(v.get("headers")),
            ),
            Err(_) => (None, None),
        }
    }

    fn listener_height(&mut self, endpoint: &str, keys: &[&str]) -> Option<u64> {
        let d = self
            .listener_data("POST", endpoint, "", Some(&json!({})), STATUS_TIMEOUT)
            .ok()?;
        for k in keys {
            if !nullish(d.get(*k)) {
                return normalize_height(d.get(*k));
            }
        }
        normalize_height(Some(&d))
    }

    fn collect_heights(&mut self, h: &mut Heights) {
        let last = |k: &str, s: &Option<Value>| -> Option<u64> {
            s.as_ref().and_then(|v| v.get(k)).and_then(Value::as_u64)
        };
        let parsed = self.listener_height(
            "tl_getMaxParsedHeight",
            &["maxParsedHeight", "parsedHeight"],
        );
        let processed = self.listener_height(
            "tl_getMaxProcessedHeight",
            &["maxProcessedHeight", "processedHeight"],
        );
        let track =
            self.listener_height("tl_getTrackHeight", &["trackHeight", "maxProcessedHeight"]);
        h.parsed = parsed
            .or(h.parsed)
            .or(last("parsedHeight", &self.last_sync));
        h.processed = processed
            .or(h.processed)
            .or(last("processedHeight", &self.last_sync));
        h.track = track.or(h.track).or(last("trackHeight", &self.last_sync));
    }

    /// `getTradeLayerSyncStatus` (`tradelayer-sync.service.ts`) without the spawn: the
    /// listener is the TradeLayer-Rust engine, so an unreachable one is reported, not started.
    fn tl_sync_status(&mut self) -> Value {
        let (node_block, header_block) = self.node_block_state();
        let mut meta = Meta {
            listener_url: self.listener_origin(),
            reachable: true,
            error: Value::Null,
            node_block,
            header_block,
            heights: Heights::default(),
        };
        let mut raw = Value::Object(Map::new());
        match self.listener_call(
            "POST",
            "tl_getSyncStatus",
            "",
            Some(&json!({})),
            STATUS_TIMEOUT,
        ) {
            Ok(r) if (200..300).contains(&r.status) => {
                if r.body.is_object() {
                    raw = r.body;
                }
                let mut h = Heights::default();
                self.collect_heights(&mut h);
                meta.heights = h;
            }
            Ok(r) if r.status == 429 => {
                raw = self.with_last(json!({
                    "phase": "paused",
                    "message": "Litecoin node sync status is temporarily rate limited.",
                    "initialized": true,
                }));
                let mut h = Heights::default();
                self.collect_heights(&mut h);
                meta.heights = h;
                return self.finalize_sync(&raw, meta);
            }
            other => {
                meta.reachable = false;
                meta.error = match other {
                    Ok(r) if truthy(&r.body) => r.body,
                    Ok(r) => json!(format!("Request failed with status code {}", r.status)),
                    Err(e) => json!(e),
                };
                if node_block.is_none() {
                    raw = self.with_last(json!({
                        "phase": "starting",
                        "message": "Waiting for Litecoin Core RPC before node sync status.",
                        "currentHeight": null,
                        "targetHeight": header_block,
                    }));
                    return self.finalize_sync(&raw, meta);
                }
                raw = match self.last_sync.clone() {
                    Some(last) => {
                        let mut m = Map::new();
                        for k in [
                            "phase",
                            "message",
                            "initialized",
                            "genesisBlock",
                            "chainTip",
                            "indexedHeight",
                            "parsedHeight",
                            "processedHeight",
                            "trackHeight",
                            "currentHeight",
                            "targetHeight",
                            "percent",
                            "updatedAt",
                        ] {
                            if let Some(v) = last.get(k) {
                                m.insert(k.into(), v.clone());
                            }
                        }
                        Value::Object(m)
                    }
                    None => Value::Object(Map::new()),
                };
            }
        }
        if meta.reachable && node_block.is_some() && !raw.get("initialized").is_some_and(truthy) {
            let target = header_block.or(node_block);
            raw = json!({
                "phase": "starting",
                "message": "Initializing Litecoin node sync.",
                "targetHeight": target,
                "currentHeight": node_block,
            });
            let init = self.listener_data(
                "POST",
                "tl_initmain",
                "",
                Some(&json!({ "wallet": true })),
                INIT_TIMEOUT,
            );
            let init = init.and_then(|d| match d.get("error").filter(|e| truthy(e)) {
                Some(e) => Err(js_string(e)),
                None => Ok(()),
            });
            match init {
                Ok(()) => {
                    if let Ok(d) = self.listener_data(
                        "POST",
                        "tl_getSyncStatus",
                        "",
                        Some(&json!({})),
                        STATUS_TIMEOUT,
                    ) {
                        if d.is_object() {
                            raw = d;
                        }
                    }
                    let mut h = meta.heights;
                    self.collect_heights(&mut h);
                    meta.heights = h;
                    meta.error = Value::Null;
                }
                Err(e) => meta.error = json!(e),
            }
        }
        self.finalize_sync(&raw, meta)
    }

    /// `raw` plus the heights of the last status, as FE-speed carries them across a failure.
    fn with_last(&self, mut raw: Value) -> Value {
        if let (Some(last), Some(m)) = (self.last_sync.as_ref(), raw.as_object_mut()) {
            for k in [
                "processedHeight",
                "trackHeight",
                "parsedHeight",
                "currentHeight",
                "targetHeight",
                "chainTip",
                "indexedHeight",
                "genesisBlock",
            ] {
                if !m.contains_key(k) || m[k].is_null() {
                    if let Some(v) = last.get(k) {
                        m.insert(k.into(), v.clone());
                    }
                }
            }
        }
        raw
    }

    fn finalize_sync(&mut self, raw: &Value, meta: Meta) -> Value {
        let status = normalize_status(raw, &meta);
        self.last_sync = Some(status.clone());
        status
    }

    // ------------------------------------------------------------------ node routes

    pub(super) fn ensure_node(&mut self) -> NodeState {
        if self.node.is_some() {
            return NodeState::Ready;
        }
        let Some(mut client) = self.pending.take() else {
            return NodeState::Missing;
        };
        match probe_node(client.as_mut()) {
            Probe::Ready => {
                self.node = Some(client);
                NodeState::Ready
            }
            Probe::Starting(m) => {
                self.pending = Some(client);
                NodeState::Starting(m)
            }
            Probe::Auth(_) | Probe::Other(_) => NodeState::Missing,
        }
    }

    /// `POST /api/rpc-call`.
    pub(super) fn rpc_call(&mut self, b: &Value) -> Result<(u16, Value), String> {
        let method = req_str(b, "method")?;
        let params: Vec<Value> = match b.get("params") {
            None | Some(Value::Null) => vec![],
            Some(Value::Array(a)) => a.clone(),
            Some(_) => return Err("params must be an array".into()),
        };
        if let Err(d) = self.gate.check_rpc(method, params.len()) {
            return Ok(fail(d.status(), format!("rpc method denied: {d:?}")));
        }
        if self.tl_rpc_via_listener && method.starts_with("tl_") {
            return Ok(self.tl_rpc(method, b));
        }
        let wallet = wallet_name(b)?.filter(|_| WALLET_METHODS.contains(&method));
        match self.ensure_node() {
            NodeState::Ready => {}
            NodeState::Starting(m) => return Ok((200, json!({ "error": m }))),
            NodeState::Missing => return Err("No RPC Client initialized".into()),
        }
        let node = self.node.as_mut().ok_or("No RPC Client initialized")?;
        let outcome = match &wallet {
            Some(w) => node.call_wallet(w, method, &params),
            None => node.call_detailed(method, &params),
        };
        // Legacy answered 200 for every node outcome; only a missing client was a 500.
        Ok(match outcome {
            RpcOutcome::Ok(v) => ok(v),
            RpcOutcome::RpcError { code, message } => (
                200,
                json!({ "error": message, "statusCode": 500, "IECode": 2, "EECode": code }),
            ),
            RpcOutcome::Failed(e) => (200, json!({ "error": e })),
        })
    }

    /// `tl_*` through `rpc-call` in listener mode (`proxyWalletMethod`).
    fn tl_rpc(&mut self, method: &str, b: &Value) -> (u16, Value) {
        match build_payload(method, b) {
            Ok(Some(payload)) => return ok(Value::String(payload)),
            Ok(None) => {}
            Err(e) => return fail(500, e),
        }
        let body = if b.is_null() { json!({}) } else { b.clone() };
        match self.listener_data("POST", method, "", Some(&body), LISTENER_TIMEOUT) {
            Ok(d) => (200, d),
            Err(e) if is_transient(&e) => (200, json!({ "error": e })),
            Err(e) => fail(500, e),
        }
    }

    /// `POST /api/start-wallet-node`. FE-speed answers once the node is reachable
    /// (`{data:true, attached:true}`) or, while it is still loading, at once with
    /// `{data:true, attached:false, starting:true, message}` and keeps attaching in the
    /// background ([`WalletService::poll_pending_node`], and every `rpc-call`). Failures after
    /// the arguments validated are `200 {error}` (the UI opens its config dialog on one).
    pub(super) fn start_wallet_node(&mut self, b: &Value) -> Result<(u16, Value), String> {
        let network = req_str(b, "network")?;
        let testnet = is_testnet(network).map_err(|e| e.to_string())?;
        let dir = self.resolve_dir(b.get("path").and_then(Value::as_str))?;
        let opts = LaunchOptions {
            testnet,
            startclean: b
                .get("startclean")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            reindex: b.get("reindex").and_then(Value::as_bool).unwrap_or(false),
            // The UI sends `path: ""` for the default directory; legacy only added `-datadir`
            // for a truthy value (`node.service.ts:110`).
            datadir: b
                .get("path")
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty())
                .map(str::to_string),
        };
        // Validates the launch arguments (the legacy exec of the bundled node is disabled).
        launch_args(&opts).map_err(|e| e.to_string())?;
        self.rescan_opt_in = b.get("allowRescan").is_some_and(truthy);
        let conf_path = format!("{}/litecoin.conf", dir.trim_end_matches(['/', '\\']));
        let Some(text) = self.store.read(&conf_path) else {
            return Ok((
                200,
                json!({ "error": format!("Config file (litecoin.conf) doesn't exist in: {dir}") }),
            ));
        };
        let ep = match rpc_endpoint(&parse_conf(&text), testnet) {
            Ok(ep) => ep,
            Err(_) => {
                return Ok((
                    200,
                    json!({ "error": format!("Incorrect Config File {dir}") }),
                ));
            }
        };
        let mut client = match self.connector.connect(&ep, testnet) {
            Ok(c) => c,
            Err(e) => return Ok((200, json!({ "error": e }))),
        };
        let reply = match probe_node(client.as_mut()) {
            Probe::Ready => {
                self.node = Some(client);
                self.pending = None;
                json!({ "data": true, "attached": true })
            }
            Probe::Starting(_) => {
                self.node = None;
                self.pending = Some(client);
                self.pending_polls = 0;
                json!({ "data": true, "attached": false, "starting": true, "message": STARTING_MESSAGE })
            }
            Probe::Auth(e) => json!({ "error": format!(
                "A Litecoin node is already listening on RPC port {}, but it rejected the wallet RPC credentials. Update litecoin.conf. {e}",
                ep.port
            ) }),
            Probe::Other(e) => json!({ "error": format!(
                "Litecoin RPC on port {} returned an unexpected error: {e}",
                ep.port
            ) }),
        };
        if reply.get("data").is_some() {
            self.network_label = Some(network.to_string());
        }
        Ok((200, reply))
    }

    pub(super) fn stop_wallet_node(&mut self) -> Result<(u16, Value), String> {
        self.pending = None;
        if let Some(node) = self.node.as_mut() {
            node.call("stop", &[])?;
        }
        self.node = None;
        Ok(ok(json!(true)))
    }
}

/// What `rpc-call` finds when it needs the node.
pub(super) enum NodeState {
    Ready,
    /// A client exists but the node is still starting.
    Starting(String),
    Missing,
}

fn wallet_name(b: &Value) -> Result<Option<String>, String> {
    for k in ["walletName", "walletLabel"] {
        if let Some(v) = b.get(k) {
            if truthy(v) {
                let s = js_string(v).trim().to_string();
                if s.is_empty() {
                    continue;
                }
                if s.len() > 128 || s.chars().any(char::is_control) {
                    return Err("walletLabel malformed".into());
                }
                return Ok(Some(s));
            }
        }
    }
    Ok(None)
}

/// Routes FE-speed serves that the desktop build does not: the explorer page and API, the
/// relayer-shaped `/address/*` and `/rpc/*` (the UI reaches those on the relayer URL it chose,
/// never through `homeApiUrl`), BitVM and the algo runner.
fn is_unavailable(path: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "/explorer/",
        "/address/",
        "/rpc/",
        "/api/bitvm/",
        "/api/algo/",
        "/algo/",
    ];
    const EXACT: &[&str] = &[
        "/explorer",
        "/api/build-bitvm-dlc-setup",
        "/api/build-bitvm-dlc-tx",
    ];
    EXACT.contains(&path) || PREFIXES.iter().any(|p| path.starts_with(p))
}

// ---------------------------------------------------------------------- sync status values

#[derive(Default, Clone, Copy)]
struct Heights {
    parsed: Option<u64>,
    processed: Option<u64>,
    track: Option<u64>,
}

struct Meta {
    listener_url: String,
    reachable: bool,
    error: Value,
    node_block: Option<u64>,
    header_block: Option<u64>,
    heights: Heights,
}

fn normalize_height(v: Option<&Value>) -> Option<u64> {
    let n = to_number(v);
    if n.is_finite() && n >= 0.0 {
        Some(n.floor() as u64)
    } else {
        None
    }
}

fn two_decimals(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn normalize_percent(current: Option<u64>, target: Option<u64>, raw: Option<&Value>) -> f64 {
    let parsed = to_number(raw);
    if parsed.is_finite() && parsed > 0.0 {
        let scaled = if parsed <= 1.0 {
            parsed * 100.0
        } else {
            parsed
        };
        return two_decimals(scaled.clamp(0.0, 100.0));
    }
    if let (Some(c), Some(t)) = (current, target) {
        if t > 0 {
            return two_decimals((c as f64 / t as f64 * 100.0).clamp(0.0, 100.0));
        }
    }
    0.0
}

/// `normalizeTradeLayerSyncStatus`.
fn normalize_status(raw: &Value, m: &Meta) -> Value {
    let g = |k: &str| raw.get(k);
    let parsed = normalize_height(g("parsedHeight")).or(m.heights.parsed);
    let processed = normalize_height(g("processedHeight")).or(m.heights.processed);
    let track = normalize_height(g("trackHeight")).or(m.heights.track);
    let current = normalize_height(g("currentHeight")).or(m.node_block);
    let target = normalize_height(g("targetHeight"))
        .or_else(|| normalize_height(g("chainTip")))
        .or(m.header_block)
        .or(m.node_block);
    let raw_phase = {
        let s = match g("phase") {
            Some(v) if truthy(v) => js_string(v),
            _ => if m.reachable { "idle" } else { "unavailable" }.to_string(),
        };
        let s = s.trim().to_string();
        if s.is_empty() {
            "idle".to_string()
        } else {
            s
        }
    };
    let phase = if current.is_some() && raw_phase == "waiting" {
        "realtime".to_string()
    } else {
        raw_phase
    };
    let message = match g("message") {
        Some(v) if truthy(v) => js_string(v),
        _ if m.reachable => String::new(),
        _ => "TradeLayer listener is unavailable.".to_string(),
    };
    let updated = g("updatedAt")
        .map(|v| to_number(Some(v)))
        .filter(|f| f.is_finite());
    json!({
        "listenerUrl": m.listener_url,
        "listenerReachable": m.reachable,
        "listenerError": m.error,
        "initialized": g("initialized").is_some_and(truthy),
        "phase": phase,
        "message": message.trim(),
        "genesisBlock": normalize_height(g("genesisBlock")),
        "chainTip": normalize_height(g("chainTip")).or(m.node_block),
        "indexedHeight": normalize_height(g("indexedHeight")),
        "parsedHeight": parsed,
        "processedHeight": processed,
        "trackHeight": track,
        "currentHeight": current,
        "targetHeight": target,
        "percent": normalize_percent(m.node_block, m.header_block.or(target), g("percent")),
        "updatedAt": updated,
        "nodeBlock": m.node_block,
        "headerBlock": m.header_block,
    })
}

/// What a fresh client's `getblockchaininfo` says about the node.
pub(super) enum Probe {
    Ready,
    /// Still starting, or the connection was refused: keep trying.
    Starting(String),
    /// The node rejected the credentials.
    Auth(String),
    Other(String),
}

pub(super) fn probe_node(node: &mut dyn RpcBackend) -> Probe {
    classify_probe(node.call_detailed("getblockchaininfo", &[]))
}

fn classify_probe(outcome: RpcOutcome) -> Probe {
    match outcome {
        RpcOutcome::Ok(_) => Probe::Ready,
        RpcOutcome::RpcError { code, message } => {
            if code == -28 || is_transient(&message) {
                Probe::Starting(message)
            } else if is_auth_error(&message) {
                Probe::Auth(message)
            } else {
                Probe::Other(message)
            }
        }
        RpcOutcome::Failed(message) => {
            if is_auth_error(&message) {
                Probe::Auth(message)
            } else if is_transient(&message) {
                Probe::Starting(message)
            } else {
                Probe::Other(message)
            }
        }
    }
}
