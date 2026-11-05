//! Opt-in TradeLayer-Rust engine as the FE-speed listener.
//!
//! With `tl_engine = "tradelayer-rust"` the `/tlraw/*` and listener-backed `/tl/*` routes are
//! answered by [`RustEngineListener`] instead of an HTTP listener on `tl_listener_url`: each
//! listener endpoint is mapped to a method of `tradelayer-rpcd` (JSON-RPC 2.0 over loopback
//! HTTP, `tl_engine_url`) and the reply is reshaped to what FE-speed's UI parses. The mapping
//! table, shapes and the endpoints rpcd cannot answer are in `docs/listener-map.md`.
//!
//! Policy for what rpcd cannot answer: the listener's own "unavailable" answer
//! (`503 {"error":"unavailable","capability":"..."}`, the shape TradeLayer-Rust's HTTP service
//! uses). No endpoint is answered with an invented empty result.
//!
//! The default (`tl_engine` absent or `"http"`) is the unchanged HTTP listener passthrough.

use crate::legacy::fespeed::{normalize_listener_url, ListenerClient};
use crate::legacy::{http_client_with, read_bounded};
use serde_json::{json, Map, Number, Value};
use std::path::PathBuf;
use std::time::Duration;
use tl_wallet_service::service::{ListenerBackend, ListenerReply};

/// rpcd's default bind (`--bind`), used when `tl_engine_url` is absent.
pub const DEFAULT_ENGINE_URL: &str = "http://127.0.0.1:7360";
pub const ENGINE_HTTP: &str = "http";
pub const ENGINE_RUST: &str = "tradelayer-rust";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// rpcd's own whole-request deadline is 5 s.
const MAX_TIMEOUT: Duration = Duration::from_secs(10);
/// rpcd bounds its replies far below this; the cap is a backstop.
const MAX_REPLY_BYTES: usize = 8 << 20;
const MAX_ENGINE_ARGS: usize = 32;
const MAX_ENGINE_ARG_BYTES: usize = 1024;
/// rpcd's `AccountId` bound.
const MAX_ADDRESS_BYTES: usize = 90;
/// Atoms per whole unit: the 1e8 scale TradeLayer-Rust renders amounts with.
const ATOMS_PER_UNIT_DIGITS: usize = 8;

// ------------------------------------------------------------------ settings

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    /// FE-speed's listener contract over HTTP at `tl_listener_url` (the default).
    Http,
    /// `tradelayer-rpcd` JSON-RPC at `tl_engine_url`, adapted by [`RustEngineListener`].
    TradelayerRust,
}

/// `tl_engine*` settings of the config file, validated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineSettings {
    pub engine: Engine,
    /// Normalised loopback origin of rpcd (meaningful for `TradelayerRust`).
    pub url: String,
    /// Sidecar: rpcd binary to start with the app. `None`: never started.
    pub cmd: Option<PathBuf>,
    pub args: Vec<String>,
}

impl Default for EngineSettings {
    fn default() -> EngineSettings {
        EngineSettings {
            engine: Engine::Http,
            url: DEFAULT_ENGINE_URL.to_string(),
            cmd: None,
            args: Vec::new(),
        }
    }
}

/// The raw `tl_engine*` config fields.
#[derive(Default)]
pub struct RawEngine {
    pub engine: Option<String>,
    pub url: Option<String>,
    pub cmd: Option<PathBuf>,
    pub args: Option<Vec<String>>,
}

/// `host:port` of a normalised loopback origin, as rpcd's `--bind` spells it.
fn bind_authority(origin: &str) -> Result<String, String> {
    let u = reqwest::Url::parse(origin).map_err(|_| "not a URL".to_string())?;
    let host = u.host_str().ok_or("URL has no host")?;
    let port = u.port_or_known_default().ok_or("URL has no port")?;
    Ok(format!("{host}:{port}"))
}

/// Validate the `tl_engine*` fields.
///
/// * `tl_engine`: `"http"` (default) or `"tradelayer-rust"`.
/// * `tl_engine_url`: plain-`http` loopback origin of rpcd (default `http://127.0.0.1:7360`).
/// * `tl_engine_cmd`: absolute path of the rpcd binary to start with the app (default: not
///   started). `tl_engine_args`: its arguments. `--allow-nonloopback` is refused, and a `--bind`
///   must equal the `tl_engine_url` authority so the adapter talks to the process it started.
///
/// Every `tl_engine_*` field requires `tl_engine = "tradelayer-rust"`.
pub fn validate(raw: RawEngine) -> Result<EngineSettings, String> {
    let engine = match raw.engine.as_deref() {
        None | Some(ENGINE_HTTP) => Engine::Http,
        Some(ENGINE_RUST) => Engine::TradelayerRust,
        Some(other) => {
            return Err(format!(
                "config: tl_engine {other:?} must be \"{ENGINE_HTTP}\" or \"{ENGINE_RUST}\""
            ))
        }
    };
    if engine == Engine::Http {
        if raw.url.is_some() || raw.cmd.is_some() || raw.args.is_some() {
            return Err(format!(
                "config: tl_engine_url, tl_engine_cmd and tl_engine_args need tl_engine = \"{ENGINE_RUST}\""
            ));
        }
        return Ok(EngineSettings::default());
    }
    let url = match raw.url {
        None => DEFAULT_ENGINE_URL.to_string(),
        Some(u) => {
            let o = normalize_listener_url(&u)
                .map_err(|e| format!("config: tl_engine_url {u:?}: {e}"))?;
            if !o.starts_with("http://") {
                return Err(format!(
                    "config: tl_engine_url {u:?}: rpcd speaks plain http"
                ));
            }
            o
        }
    };
    let args = raw.args.unwrap_or_default();
    if raw.cmd.is_none() && !args.is_empty() {
        return Err("config: tl_engine_args need tl_engine_cmd".into());
    }
    if let Some(c) = &raw.cmd {
        if !c.is_absolute() {
            return Err("config: tl_engine_cmd must be an absolute path".into());
        }
    }
    if args.len() > MAX_ENGINE_ARGS || args.iter().any(|a| a.len() > MAX_ENGINE_ARG_BYTES) {
        return Err("config: tl_engine_args too long".into());
    }
    if args.iter().any(|a| a == "--allow-nonloopback") {
        return Err("config: tl_engine_args must not contain --allow-nonloopback".into());
    }
    if let Some(i) = args.iter().position(|a| a == "--bind") {
        let want = bind_authority(&url).map_err(|e| format!("config: tl_engine_url: {e}"))?;
        if args.get(i + 1).map(String::as_str) != Some(want.as_str()) {
            return Err(format!(
                "config: tl_engine_args --bind must be {want} (the tl_engine_url authority)"
            ));
        }
    }
    Ok(EngineSettings {
        engine,
        url,
        cmd: raw.cmd,
        args,
    })
}

/// The listener the service uses: the HTTP passthrough, or the rpcd adapter.
pub fn listener_for(
    engine: &EngineSettings,
    tl_listener_url: &str,
) -> Result<Box<dyn ListenerBackend>, String> {
    match engine.engine {
        Engine::Http => Ok(Box::new(ListenerClient::new(tl_listener_url)?)),
        Engine::TradelayerRust => Ok(Box::new(RustEngineListener::new(&engine.url)?)),
    }
}

// ------------------------------------------------------------------ endpoint table

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Route {
    InitMain,
    SyncStatus,
    MaxParsedHeight,
    MaxProcessedHeight,
    TrackHeight,
    CheckSync,
    AllBalances,
    ListProperties,
    GetProperty,
    Unavailable(&'static str),
}

/// Every FE-speed listener endpoint (the `/tlraw/*` allowlist) with its verb and mapping.
/// `docs/listener-map.md` is this table with the shape notes.
const ROUTES: &[(&str, &str, Route)] = &[
    ("tl_initmain", "POST", Route::InitMain),
    ("tl_getSyncStatus", "POST", Route::SyncStatus),
    ("tl_getMaxParsedHeight", "POST", Route::MaxParsedHeight),
    (
        "tl_getMaxProcessedHeight",
        "POST",
        Route::MaxProcessedHeight,
    ),
    ("tl_getTrackHeight", "POST", Route::TrackHeight),
    ("tl_checkSync", "POST", Route::CheckSync),
    ("tl_loadWallet", "POST", Route::Unavailable("wallet_load")),
    (
        "tl_getStateSnapshot",
        "POST",
        Route::Unavailable("state_snapshot"),
    ),
    ("tl_getAllBalancesForAddress", "POST", Route::AllBalances),
    ("tl_getChannel", "POST", Route::Unavailable("channel_view")),
    (
        "tl_getChannelColumn",
        "POST",
        Route::Unavailable("channel_lifecycle_view"),
    ),
    ("tl_listProperties", "POST", Route::ListProperties),
    ("tl_getProperty", "POST", Route::GetProperty),
    (
        "tl_getAttestations",
        "POST",
        Route::Unavailable("attestation_registry"),
    ),
    (
        "tl_getTransaction",
        "POST",
        Route::Unavailable("transaction_index"),
    ),
    (
        "tl_getClearlistById",
        "POST",
        Route::Unavailable("clearlist_registry"),
    ),
    (
        "tl_listContractSeries",
        "POST",
        Route::Unavailable("contract_registry"),
    ),
    (
        "tl_watchonly_register",
        "POST",
        Route::Unavailable("watchonly_index"),
    ),
    (
        "tl_watchonly_utxos",
        "POST",
        Route::Unavailable("watchonly_index"),
    ),
    (
        "tl_contractPosition",
        "GET",
        Route::Unavailable("contract_positions"),
    ),
    (
        "tl_getContractInfo",
        "GET",
        Route::Unavailable("contract_registry"),
    ),
    (
        "tl_getInitMargin",
        "GET",
        Route::Unavailable("contract_registry"),
    ),
    (
        "tl_channelBalanceForCommiter",
        "GET",
        Route::Unavailable("channel_view"),
    ),
    (
        "tl_getMaxSynth",
        "GET",
        Route::Unavailable("synthetic_metadata"),
    ),
    (
        "tl_tokenTradeHistoryForAddress",
        "GET",
        Route::Unavailable("spot_fill_owner_history"),
    ),
    (
        "tl_contractTradeHistoryForAddress",
        "GET",
        Route::Unavailable("contract_history"),
    ),
    (
        "tl_totalTradeHistoryForAddress",
        "GET",
        Route::Unavailable("address_history"),
    ),
    (
        "tl_contractTradeHistory",
        "GET",
        Route::Unavailable("contract_history"),
    ),
    (
        "tl_fundingHistory",
        "GET",
        Route::Unavailable("funding_history"),
    ),
    (
        "tl_oracleHistory",
        "GET",
        Route::Unavailable("oracle_history"),
    ),
];

// ------------------------------------------------------------------ replies

fn reply(status: u16, body: Value) -> Result<ListenerReply, String> {
    Ok(ListenerReply { status, body })
}

fn ok(body: Value) -> Result<ListenerReply, String> {
    reply(200, body)
}

fn unavailable(capability: &str) -> Result<ListenerReply, String> {
    reply(
        503,
        json!({ "error": "unavailable", "capability": capability }),
    )
}

fn invalid() -> Result<ListenerReply, String> {
    reply(400, json!({ "error": "invalid_request" }))
}

fn not_found() -> Result<ListenerReply, String> {
    reply(404, json!({ "error": "not_found" }))
}

fn backend(why: &str) -> Result<ListenerReply, String> {
    reply(500, json!({ "error": "backend", "capability": why }))
}

fn transport() -> Result<ListenerReply, String> {
    reply(502, json!({ "error": "transport" }))
}

// ------------------------------------------------------------------ JSON-RPC client

/// What a JSON-RPC call came back as.
#[derive(Debug, PartialEq)]
enum Outcome {
    Result(Value),
    /// A JSON-RPC error object.
    Rpc(i64),
    /// rpcd answered with a non-200 HTTP status (empty body by design).
    Http(u16),
    /// A 200 that is not a well-formed JSON-RPC 2.0 reply to this request.
    Malformed,
}

/// The adapter: FE-speed listener calls in, `tradelayer-rpcd` JSON-RPC out.
pub struct RustEngineListener {
    url: reqwest::Url,
    origin: String,
    client: reqwest::blocking::Client,
    next_id: u64,
}

impl RustEngineListener {
    pub fn new(url: &str) -> Result<RustEngineListener, String> {
        let origin = normalize_listener_url(url)?;
        if !origin.starts_with("http://") {
            return Err("tradelayer-rpcd speaks plain http".into());
        }
        let u = reqwest::Url::parse(&format!("{origin}/")).map_err(|e| e.to_string())?;
        let client = http_client_with(&u, CONNECT_TIMEOUT, MAX_TIMEOUT)?;
        Ok(RustEngineListener {
            url: u,
            origin,
            client,
            next_id: 1,
        })
    }

    fn refused(&self) -> String {
        let host = match self.url.host_str() {
            Some("localhost") | None => "127.0.0.1",
            Some(h) => h.trim_start_matches('[').trim_end_matches(']'),
        };
        format!(
            "connect ECONNREFUSED {host}:{}",
            self.url.port_or_known_default().unwrap_or(0)
        )
    }

    /// One JSON-RPC call. `Err` is a transport failure worded like axios's.
    fn call(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Outcome, String> {
        let id = self.next_id;
        self.next_id += 1;
        let body = json!({ "jsonrpc": "2.0", "method": method, "params": params, "id": id });
        let timeout = timeout.min(MAX_TIMEOUT);
        let resp = self
            .client
            .post(self.url.clone())
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .timeout(timeout)
            .send()
            .map_err(|e| {
                if e.is_timeout() {
                    format!("timeout of {}ms exceeded", timeout.as_millis())
                } else if e.is_connect() {
                    self.refused()
                } else {
                    format!("request failed: {}", e.without_url())
                }
            })?;
        let status = resp.status().as_u16();
        if status != 200 {
            return Ok(Outcome::Http(status));
        }
        if resp
            .content_length()
            .is_some_and(|n| n > MAX_REPLY_BYTES as u64)
        {
            return Err("response too large".into());
        }
        let bytes = read_bounded(resp, MAX_REPLY_BYTES).map_err(|e| {
            if e.contains("response read failed") {
                format!("timeout of {}ms exceeded", timeout.as_millis())
            } else {
                e
            }
        })?;
        Ok(parse_reply(&bytes, id))
    }
}

/// A well-formed reply: `jsonrpc` is `"2.0"`, `id` echoes ours, and exactly one of `result` and
/// `error` is present.
fn parse_reply(bytes: &[u8], id: u64) -> Outcome {
    let Ok(Value::Object(m)) = serde_json::from_slice::<Value>(bytes) else {
        return Outcome::Malformed;
    };
    if m.get("jsonrpc") != Some(&json!("2.0")) || m.get("id") != Some(&json!(id)) {
        return Outcome::Malformed;
    }
    match (m.get("result"), m.get("error")) {
        (Some(r), None) => Outcome::Result(r.clone()),
        (None, Some(e)) => match e.get("code").and_then(Value::as_i64) {
            Some(c) => Outcome::Rpc(c),
            None => Outcome::Malformed,
        },
        _ => Outcome::Malformed,
    }
}

// ------------------------------------------------------------------ parameter parsing

fn truthy(v: &Value) -> bool {
    !matches!(v, Value::Null | Value::Bool(false))
        && v.as_str() != Some("")
        && v.as_f64() != Some(0.0)
}

/// rpcd's `AccountId`: non-empty printable ASCII, at most 90 bytes.
fn address_of(v: &Value) -> Option<&str> {
    let s = v.as_str()?;
    (!s.is_empty() && s.len() <= MAX_ADDRESS_BYTES && s.bytes().all(|b| (0x20..=0x7e).contains(&b)))
        .then_some(s)
}

/// A property id: a canonical unsigned decimal (JSON number or string), 1..=u32::MAX.
fn property_id_of(v: &Value) -> Option<u32> {
    let text = match v {
        Value::Number(n) => n.as_u64()?.to_string(),
        Value::String(s) => s.clone(),
        _ => return None,
    };
    if text.is_empty()
        || !text.bytes().all(|b| b.is_ascii_digit())
        || (text.len() > 1 && text.starts_with('0'))
    {
        return None;
    }
    text.parse::<u32>().ok().filter(|n| *n != 0)
}

/// The address of a `tl_getAllBalancesForAddress` body: `params` (FE-speed) or `address`; both
/// must agree when both are given (as in the listener's repaired route).
fn balances_address(body: &Value) -> Option<String> {
    let get = |k: &str| body.get(k).filter(|v| truthy(v));
    match (get("address"), get("params")) {
        (Some(a), Some(p)) => {
            let (a, p) = (address_of(a)?, address_of(p)?);
            (a == p).then(|| a.to_string())
        }
        (Some(a), None) | (None, Some(a)) => address_of(a).map(str::to_string),
        (None, None) => None,
    }
}

// ------------------------------------------------------------------ reshaping

/// `atoms / 1e8` as the JSON number the UI computes with (exact decimal text, rounded once by
/// the float parse). `None` for anything that is not an unsigned decimal string.
fn atoms_to_units(atoms: &Value) -> Option<Number> {
    let s = atoms.as_str()?;
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let digits = s.trim_start_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let padded = format!("{digits:0>width$}", width = ATOMS_PER_UNIT_DIGITS + 1);
    let (whole, frac) = padded.split_at(padded.len() - ATOMS_PER_UNIT_DIGITS);
    let n: f64 = format!("{whole}.{frac}").parse().ok()?;
    Number::from_f64(n)
}

fn unit_value(atoms: &Value) -> Option<Value> {
    atoms_to_units(atoms).map(Value::Number)
}

/// rpcd `{propertyid, balance}` -> FE-speed's token balance row. rpcd serves the available
/// balance only, so `reserved`, `margin`, `vesting` and `channel` are 0 here (see the doc).
fn balance_row(row: &Value) -> Option<Value> {
    let id = row.get("propertyid")?.as_u64()?;
    let amount = unit_value(row.get("balance")?)?;
    Some(json!({
        "propertyId": id,
        "amount": amount,
        "available": amount,
        "reserved": 0,
        "margin": 0,
        "vesting": 0,
        "channel": 0,
    }))
}

/// rpcd `{propertyid, issuer, kind, total_supply_atoms}` -> the property row FE-speed reads
/// (`id`, `propertyId`; no `ticker`: the checkpoint carries none).
fn property_row(row: &Value) -> Option<Value> {
    let id = row.get("propertyid")?.as_u64()?;
    let supply = row.get("total_supply_atoms")?;
    let mut m = Map::new();
    m.insert("id".into(), json!(id));
    m.insert("propertyId".into(), json!(id));
    m.insert("issuer".into(), row.get("issuer")?.clone());
    m.insert("kind".into(), row.get("kind")?.clone());
    m.insert("totalSupply".into(), unit_value(supply)?);
    m.insert("totalSupplyAtoms".into(), supply.clone());
    Some(Value::Object(m))
}

/// The checkpoint's finalized height: a number or null.
fn height_of(sync: &Value) -> Option<Value> {
    match sync.get("finalized_height")? {
        v @ Value::Null => Some(v.clone()),
        v if v.is_u64() => Some(v.clone()),
        _ => None,
    }
}

impl ListenerBackend for RustEngineListener {
    fn request(
        &mut self,
        method: &str,
        endpoint: &str,
        _query: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<ListenerReply, String> {
        let Some(&(_, verb, route)) = ROUTES.iter().find(|(n, _, _)| *n == endpoint) else {
            return reply(404, json!({ "error": "not_found" }));
        };
        if method != verb {
            return reply(405, json!({ "error": "method_not_allowed" }));
        }
        let null = Value::Null;
        let body = body.unwrap_or(&null);
        let t = timeout;
        match route {
            Route::Unavailable(capability) => unavailable(capability),
            Route::InitMain => {
                let info = match self.rpc_result("tl_getinfo", json!([]), t)? {
                    Ok(v) => v,
                    Err(r) => return r,
                };
                ok(json!({
                    "initialized": true,
                    "scope": "checkpoint_read_service",
                    "daemonStarted": false,
                    "authenticated_admission": false,
                    "network": info.get("network").cloned().unwrap_or(Value::Null),
                    "finalizedHeight": info.get("finalized_height").cloned().unwrap_or(Value::Null),
                }))
            }
            Route::SyncStatus
            | Route::MaxParsedHeight
            | Route::MaxProcessedHeight
            | Route::TrackHeight
            | Route::CheckSync => {
                let sync = match self.rpc_result("tl_getsyncstatus", json!([]), t)? {
                    Ok(v) => v,
                    Err(r) => return r,
                };
                let Some(h) = height_of(&sync) else {
                    return backend("tl_getsyncstatus");
                };
                ok(heights_body(route, &h, &sync))
            }
            Route::AllBalances => {
                let Some(address) = balances_address(body) else {
                    return invalid();
                };
                let rows =
                    match self.rpc_result("tl_getallbalancesforaddress", json!([address]), t)? {
                        Ok(Value::Array(a)) => a,
                        Ok(_) => return backend("tl_getallbalancesforaddress"),
                        Err(r) => return r,
                    };
                match rows.iter().map(balance_row).collect::<Option<Vec<_>>>() {
                    Some(v) => ok(Value::Array(v)),
                    None => backend("tl_getallbalancesforaddress"),
                }
            }
            Route::ListProperties => {
                let rows = match self.rpc_result("tl_listproperties", json!([]), t)? {
                    Ok(Value::Array(a)) => a,
                    Ok(_) => return backend("tl_listproperties"),
                    Err(r) => return r,
                };
                match rows.iter().map(property_row).collect::<Option<Vec<_>>>() {
                    Some(v) => ok(Value::Array(v)),
                    None => backend("tl_listproperties"),
                }
            }
            Route::GetProperty => {
                let Some(id) = body.get("params").and_then(property_id_of) else {
                    return invalid();
                };
                let row = match self.rpc_result("tl_getproperty", json!([id]), t)? {
                    Ok(v) => v,
                    Err(r) => return r,
                };
                match property_row(&row) {
                    Some(v) => ok(v),
                    None => backend("tl_getproperty"),
                }
            }
        }
    }

    fn origin(&self) -> String {
        self.origin.clone()
    }
}

/// The body of each heights endpoint. The checkpoint has a finalized (processed) height and no
/// parser or tracking height: those stay null, never guessed (TradeLayer-Rust's own policy).
fn heights_body(route: Route, finalized: &Value, sync: &Value) -> Value {
    match route {
        Route::MaxProcessedHeight => json!({ "maxProcessedHeight": finalized }),
        Route::MaxParsedHeight => json!({ "maxParsedHeight": null }),
        Route::TrackHeight => json!({ "trackHeight": finalized, "source": "maxProcessed" }),
        Route::CheckSync => json!({
            "available": false,
            "consensus": finalized,
            "txIndex": null,
            "trackHeight": null,
            "synced": null,
        }),
        _ => json!({
            "source": "checkpoint",
            "available": false,
            "consensus": finalized,
            "txIndex": null,
            "trackHeight": null,
            "synced": null,
            "processedCount": sync.get("processed_count").cloned().unwrap_or(Value::Null),
        }),
    }
}

impl RustEngineListener {
    /// A JSON-RPC call whose `result` the caller reshapes. The outer `Err` is a transport
    /// failure (axios wording); the inner `Err` is the finished listener reply for a JSON-RPC
    /// error, a non-200 from rpcd, or a malformed reply.
    #[allow(clippy::type_complexity)]
    fn rpc_result(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Result<Value, Result<ListenerReply, String>>, String> {
        Ok(match self.call(method, params, timeout)? {
            Outcome::Result(v) => Ok(v),
            Outcome::Rpc(-32001) => Err(not_found()),
            Outcome::Rpc(-32602) => Err(invalid()),
            // rpcd has no such method (a newer listener contract than this build knows)
            Outcome::Rpc(-32601) => Err(unavailable(method)),
            Outcome::Rpc(_) => Err(backend(method)),
            Outcome::Http(_) | Outcome::Malformed => Err(transport()),
        })
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legacy::{handle_request, translate, Translated, ALLOWED_ORIGIN};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use tauri::http;
    use tl_wallet_service::gate::{Gate, GateConfig, MethodAllowlist, SessionToken};
    use tl_wallet_service::mem::{MemConnector, MemRelayer, MemStore};
    use tl_wallet_service::service::WalletService;

    const T: Duration = Duration::from_secs(5);

    // ---- a mock rpcd: one JSON-RPC request per connection, canned answers by method

    type Seen = Arc<Mutex<Vec<Value>>>;

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

    /// Serve until the process ends. `answer(request_json)` returns `(http_status, body)`.
    fn mock_rpcd(answer: impl Fn(&Value) -> (u16, String) + Send + 'static) -> (u16, Seen) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let seen: Seen = Arc::default();
        let log = seen.clone();
        std::thread::spawn(move || {
            for st in l.incoming() {
                let Ok(mut st) = st else { continue };
                let raw = read_request(&mut st);
                let text = String::from_utf8_lossy(&raw).into_owned();
                let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
                assert!(head.starts_with("POST / HTTP/1.1\r\n"), "{head}");
                let req: Value = serde_json::from_str(body).unwrap_or(Value::Null);
                let (status, out) = answer(&req);
                log.lock().unwrap().push(req);
                let resp = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}",
                    out.len()
                );
                let _ = st.write_all(resp.as_bytes());
            }
        });
        (port, seen)
    }

    /// rpcd's replies for the seeded state of its own `tests/rpc_server.rs` (properties 7 and
    /// 9, carol holding 250 and 5, finalized height 42), with amounts in atoms.
    fn rpcd_reply(req: &Value) -> (u16, String) {
        let id = req["id"].to_string();
        let params = req["params"].as_array().cloned().unwrap_or_default();
        let result = match req["method"].as_str().unwrap_or("") {
            "tl_getinfo" => r#"{"network":"litecoin","finalized_height":42,"property_count":2,"processed_count":0}"#.to_string(),
            "tl_getsyncstatus" => r#"{"source":"checkpoint","finalized_height":42,"processed_count":0}"#.to_string(),
            "tl_listproperties" => r#"[{"propertyid":7,"issuer":"alice","kind":"fixed","total_supply_atoms":"100000000000"},{"propertyid":9,"issuer":"bob","kind":"managed","total_supply_atoms":"500"}]"#.to_string(),
            "tl_getproperty" => match params.first().and_then(Value::as_u64) {
                Some(7) => r#"{"propertyid":7,"issuer":"alice","kind":"fixed","total_supply_atoms":"100000000000"}"#.to_string(),
                _ => {
                    return (
                        200,
                        format!(r#"{{"jsonrpc":"2.0","error":{{"code":-32001,"message":"Property not found"}},"id":{id}}}"#),
                    )
                }
            },
            "tl_getallbalancesforaddress" => match params.first().and_then(Value::as_str) {
                Some("carol") => r#"[{"propertyid":7,"balance":"25000000000"},{"propertyid":9,"balance":"5"}]"#.to_string(),
                _ => "[]".to_string(),
            },
            _ => {
                return (
                    200,
                    format!(r#"{{"jsonrpc":"2.0","error":{{"code":-32601,"message":"Method not found"}},"id":{id}}}"#),
                )
            }
        };
        (
            200,
            format!(r#"{{"jsonrpc":"2.0","result":{result},"id":{id}}}"#),
        )
    }

    fn engine(port: u16) -> RustEngineListener {
        RustEngineListener::new(&format!("http://127.0.0.1:{port}")).unwrap()
    }

    fn ask(l: &mut RustEngineListener, verb: &str, endpoint: &str, body: Value) -> ListenerReply {
        let b = if verb == "POST" && !body.is_null() {
            Some(&body)
        } else {
            None
        };
        l.request(verb, endpoint, "", b, T).unwrap()
    }

    fn methods(seen: &Seen) -> Vec<String> {
        seen.lock()
            .unwrap()
            .iter()
            .map(|r| r["method"].as_str().unwrap().to_string())
            .collect()
    }

    // ---- settings

    fn raw(engine: Option<&str>, url: Option<&str>, cmd: Option<&str>, args: &[&str]) -> RawEngine {
        RawEngine {
            engine: engine.map(str::to_string),
            url: url.map(str::to_string),
            cmd: cmd.map(PathBuf::from),
            args: (!args.is_empty()).then(|| args.iter().map(|a| a.to_string()).collect()),
        }
    }

    fn abs(p: &str) -> String {
        if cfg!(windows) {
            format!("C:/{p}")
        } else {
            format!("/{p}")
        }
    }

    #[test]
    fn default_is_the_http_passthrough_and_nothing_starts() {
        let d = validate(RawEngine::default()).unwrap();
        assert_eq!(d, EngineSettings::default());
        assert_eq!(d.engine, Engine::Http);
        assert!(d.cmd.is_none());
        assert_eq!(
            validate(raw(Some("http"), None, None, &[])).unwrap(),
            EngineSettings::default()
        );
        // engine fields without the engine are an error, not silently ignored
        for r in [
            raw(None, Some("http://127.0.0.1:7360"), None, &[]),
            raw(Some("http"), None, Some(&abs("x/rpcd")), &[]),
            raw(None, None, None, &["--bind", "127.0.0.1:7360"]),
        ] {
            assert!(validate(r).is_err());
        }
    }

    #[test]
    fn engine_settings_validate() {
        let s = validate(raw(Some("tradelayer-rust"), None, None, &[])).unwrap();
        assert_eq!(s.engine, Engine::TradelayerRust);
        assert_eq!(s.url, DEFAULT_ENGINE_URL);
        assert!(s.cmd.is_none());
        let cmd = abs("tl/tradelayer-rpcd.exe");
        let s = validate(raw(
            Some("tradelayer-rust"),
            Some("HTTP://LocalHost:7361/"),
            Some(&cmd),
            &["--checkpoint", "c.tljp", "--bind", "localhost:7361"],
        ))
        .unwrap();
        assert_eq!(s.url, "http://localhost:7361");
        assert_eq!(s.cmd, Some(PathBuf::from(&cmd)));
        assert_eq!(s.args.len(), 4);
        for bad in [
            raw(Some("rust"), None, None, &[]),
            raw(
                Some("tradelayer-rust"),
                Some("http://example.com:7360"),
                None,
                &[],
            ),
            raw(
                Some("tradelayer-rust"),
                Some("https://127.0.0.1:7360"),
                None,
                &[],
            ),
            raw(
                Some("tradelayer-rust"),
                Some("http://127.0.0.1:7360/x"),
                None,
                &[],
            ),
            raw(Some("tradelayer-rust"), None, Some("rpcd.exe"), &[]),
            raw(Some("tradelayer-rust"), None, None, &["--checkpoint", "c"]),
            raw(
                Some("tradelayer-rust"),
                None,
                Some(&cmd),
                &["--allow-nonloopback"],
            ),
            raw(
                Some("tradelayer-rust"),
                None,
                Some(&cmd),
                &["--bind", "127.0.0.1:9999"],
            ),
            raw(Some("tradelayer-rust"), None, Some(&cmd), &["--bind"]),
        ] {
            assert!(validate(bad).is_err());
        }
        // a --bind equal to the url authority is accepted
        assert!(validate(raw(
            Some("tradelayer-rust"),
            None,
            Some(&cmd),
            &["--bind", "127.0.0.1:7360"]
        ))
        .is_ok());
    }

    #[test]
    fn listener_for_picks_the_backend_and_the_engine_url_must_be_loopback_http() {
        let http = listener_for(&EngineSettings::default(), "http://127.0.0.1:3000").unwrap();
        assert_eq!(http.origin(), "http://127.0.0.1:3000");
        let rust = EngineSettings {
            engine: Engine::TradelayerRust,
            ..EngineSettings::default()
        };
        let l = listener_for(&rust, "http://127.0.0.1:3000").unwrap();
        assert_eq!(l.origin(), DEFAULT_ENGINE_URL);
        for bad in [
            "http://example.com:1",
            "https://127.0.0.1:1",
            "ws://127.0.0.1:1",
        ] {
            assert!(RustEngineListener::new(bad).is_err(), "{bad}");
        }
    }

    // ---- endpoint table

    #[test]
    fn the_table_is_exactly_the_tlraw_allowlist_with_its_verbs() {
        use tl_wallet_service::service::{TLRAW_GET, TLRAW_POST};
        let post: Vec<&str> = ROUTES
            .iter()
            .filter(|r| r.1 == "POST")
            .map(|r| r.0)
            .collect();
        let get: Vec<&str> = ROUTES
            .iter()
            .filter(|r| r.1 == "GET")
            .map(|r| r.0)
            .collect();
        assert_eq!(post, TLRAW_POST);
        assert_eq!(get, TLRAW_GET);
        assert_eq!((post.len(), get.len()), (19, 11));
        let served = ROUTES
            .iter()
            .filter(|r| !matches!(r.2, Route::Unavailable(_)))
            .count();
        assert_eq!(served, 9);
    }

    // ---- served endpoints, one test each

    #[test]
    fn initmain_probes_the_engine() {
        let (port, seen) = mock_rpcd(rpcd_reply);
        let r = ask(
            &mut engine(port),
            "POST",
            "tl_initmain",
            json!({"wallet": true}),
        );
        assert_eq!(r.status, 200);
        assert_eq!(
            r.body,
            json!({
                "initialized": true,
                "scope": "checkpoint_read_service",
                "daemonStarted": false,
                "authenticated_admission": false,
                "network": "litecoin",
                "finalizedHeight": 42,
            })
        );
        assert_eq!(methods(&seen), ["tl_getinfo"]);
        let sent = seen.lock().unwrap()[0].clone();
        assert_eq!(sent["jsonrpc"], "2.0");
        assert_eq!(sent["params"], json!([]));
    }

    #[test]
    fn sync_status_and_check_sync() {
        let (port, seen) = mock_rpcd(rpcd_reply);
        let mut l = engine(port);
        let r = ask(&mut l, "POST", "tl_getSyncStatus", Value::Null);
        assert_eq!(r.status, 200);
        assert_eq!(
            r.body,
            json!({
                "source": "checkpoint",
                "available": false,
                "consensus": 42,
                "txIndex": null,
                "trackHeight": null,
                "synced": null,
                "processedCount": 0,
            })
        );
        let r = ask(&mut l, "POST", "tl_checkSync", json!({}));
        assert_eq!(
            r.body,
            json!({"available": false, "consensus": 42, "txIndex": null, "trackHeight": null, "synced": null})
        );
        assert_eq!(methods(&seen), ["tl_getsyncstatus", "tl_getsyncstatus"]);
    }

    #[test]
    fn max_processed_parsed_and_track_heights() {
        let (port, _seen) = mock_rpcd(rpcd_reply);
        let mut l = engine(port);
        assert_eq!(
            ask(&mut l, "POST", "tl_getMaxProcessedHeight", Value::Null).body,
            json!({"maxProcessedHeight": 42})
        );
        assert_eq!(
            ask(&mut l, "POST", "tl_getMaxParsedHeight", Value::Null).body,
            json!({"maxParsedHeight": null})
        );
        assert_eq!(
            ask(&mut l, "POST", "tl_getTrackHeight", Value::Null).body,
            json!({"trackHeight": 42, "source": "maxProcessed"})
        );
    }

    #[test]
    fn a_checkpoint_without_a_finalized_height_reports_null_heights() {
        let (port, _s) = mock_rpcd(|req| {
            (
                200,
                format!(
                    r#"{{"jsonrpc":"2.0","result":{{"source":"checkpoint","finalized_height":null,"processed_count":0}},"id":{}}}"#,
                    req["id"]
                ),
            )
        });
        let mut l = engine(port);
        assert_eq!(
            ask(&mut l, "POST", "tl_getMaxProcessedHeight", Value::Null).body,
            json!({"maxProcessedHeight": null})
        );
        assert_eq!(
            ask(&mut l, "POST", "tl_getTrackHeight", Value::Null).body,
            json!({"trackHeight": null, "source": "maxProcessed"})
        );
    }

    #[test]
    fn all_balances_reshapes_atoms_to_units_for_params_and_address_bodies() {
        let (port, seen) = mock_rpcd(rpcd_reply);
        let mut l = engine(port);
        let want = json!([
            {"propertyId": 7, "amount": 250.0, "available": 250.0, "reserved": 0, "margin": 0, "vesting": 0, "channel": 0},
            {"propertyId": 9, "amount": 5e-8, "available": 5e-8, "reserved": 0, "margin": 0, "vesting": 0, "channel": 0},
        ]);
        let r = ask(
            &mut l,
            "POST",
            "tl_getAllBalancesForAddress",
            json!({"params": "carol"}),
        );
        assert_eq!((r.status, &r.body), (200, &want));
        let r = ask(
            &mut l,
            "POST",
            "tl_getAllBalancesForAddress",
            json!({"address": "carol"}),
        );
        assert_eq!(r.body, want);
        let r = ask(
            &mut l,
            "POST",
            "tl_getAllBalancesForAddress",
            json!({"address": "carol", "params": "carol"}),
        );
        assert_eq!(r.body, want);
        // unknown account: an empty list, as rpcd says
        let r = ask(
            &mut l,
            "POST",
            "tl_getAllBalancesForAddress",
            json!({"params": "nobody"}),
        );
        assert_eq!((r.status, r.body), (200, json!([])));
        let sent = seen.lock().unwrap();
        assert_eq!(sent[0]["method"], "tl_getallbalancesforaddress");
        assert_eq!(sent[0]["params"], json!(["carol"]));
    }

    #[test]
    fn all_balances_rejects_bad_bodies_before_the_engine() {
        let (port, seen) = mock_rpcd(rpcd_reply);
        let mut l = engine(port);
        for body in [
            json!({}),
            json!({"params": ""}),
            json!({"params": 5}),
            json!({"params": ["carol"]}),
            json!({"params": "a\u{e9}"}),
            json!({"params": "x".repeat(91)}),
            json!({"address": "a", "params": "b"}),
        ] {
            let r = ask(&mut l, "POST", "tl_getAllBalancesForAddress", body.clone());
            assert_eq!(
                (r.status, r.body),
                (400, json!({"error": "invalid_request"})),
                "{body}"
            );
        }
        let r = l
            .request("POST", "tl_getAllBalancesForAddress", "", None, T)
            .unwrap();
        assert_eq!(r.status, 400);
        assert!(methods(&seen).is_empty());
    }

    #[test]
    fn list_properties_reshapes_rows() {
        let (port, _s) = mock_rpcd(rpcd_reply);
        let r = ask(&mut engine(port), "POST", "tl_listProperties", Value::Null);
        assert_eq!(r.status, 200);
        assert_eq!(
            r.body,
            json!([
                {"id": 7, "propertyId": 7, "issuer": "alice", "kind": "fixed", "totalSupply": 1000.0, "totalSupplyAtoms": "100000000000"},
                {"id": 9, "propertyId": 9, "issuer": "bob", "kind": "managed", "totalSupply": 5e-6, "totalSupplyAtoms": "500"},
            ])
        );
    }

    #[test]
    fn get_property_by_number_or_string_and_unknown_is_404() {
        let (port, seen) = mock_rpcd(rpcd_reply);
        let mut l = engine(port);
        let want = json!({"id": 7, "propertyId": 7, "issuer": "alice", "kind": "fixed", "totalSupply": 1000.0, "totalSupplyAtoms": "100000000000"});
        for p in [json!(7), json!("7")] {
            let r = ask(&mut l, "POST", "tl_getProperty", json!({"params": p}));
            assert_eq!((r.status, &r.body), (200, &want));
        }
        assert_eq!(seen.lock().unwrap()[0]["params"], json!([7]));
        let r = ask(&mut l, "POST", "tl_getProperty", json!({"params": 99}));
        assert_eq!((r.status, r.body), (404, json!({"error": "not_found"})));
        for bad in [
            json!({}),
            json!({"params": 0}),
            json!({"params": "07"}),
            json!({"params": -1}),
            json!({"params": 1.5}),
            json!({"params": [7]}),
            json!({"params": 4294967296u64}),
        ] {
            let r = ask(&mut l, "POST", "tl_getProperty", bad.clone());
            assert_eq!(r.status, 400, "{bad}");
        }
        assert_eq!(seen.lock().unwrap().len(), 3);
    }

    // ---- the unavailable endpoints

    #[test]
    fn every_other_endpoint_is_unavailable_and_never_reaches_the_engine() {
        let (port, seen) = mock_rpcd(rpcd_reply);
        let mut l = engine(port);
        let mut n = 0;
        for (endpoint, verb, route) in ROUTES {
            let Route::Unavailable(cap) = route else {
                continue;
            };
            let r = ask(&mut l, verb, endpoint, json!({"params": ["x"]}));
            assert_eq!(
                (r.status, r.body),
                (503, json!({"error": "unavailable", "capability": cap})),
                "{endpoint}"
            );
            n += 1;
        }
        assert_eq!(n, 21);
        assert!(methods(&seen).is_empty());
    }

    #[test]
    fn the_listener_checks_the_verb_and_the_endpoint() {
        let (port, seen) = mock_rpcd(rpcd_reply);
        let mut l = engine(port);
        let r = l.request("GET", "tl_listProperties", "", None, T).unwrap();
        assert_eq!(
            (r.status, r.body),
            (405, json!({"error": "method_not_allowed"}))
        );
        let r = l
            .request("POST", "tl_contractPosition", "", None, T)
            .unwrap();
        assert_eq!(r.status, 405);
        let r = l.request("POST", "tl_check_kyc", "", None, T).unwrap();
        assert_eq!((r.status, r.body), (404, json!({"error": "not_found"})));
        assert!(methods(&seen).is_empty());
    }

    // ---- engine failure modes

    #[test]
    fn rpc_errors_and_bad_replies_map_to_listener_statuses() {
        let (port, _s) = mock_rpcd(|req| {
            let id = req["id"].to_string();
            let m = req["method"].as_str().unwrap();
            match m {
                "tl_listproperties" => (
                    200,
                    format!(
                        r#"{{"jsonrpc":"2.0","error":{{"code":-32601,"message":"Method not found"}},"id":{id}}}"#
                    ),
                ),
                "tl_getsyncstatus" => (
                    200,
                    format!(
                        r#"{{"jsonrpc":"2.0","error":{{"code":-32603,"message":"x"}},"id":{id}}}"#
                    ),
                ),
                "tl_getinfo" => (503, String::new()),
                "tl_getproperty" => (
                    200,
                    format!(r#"{{"jsonrpc":"2.0","result":{{"propertyid":"x"}},"id":{id}}}"#),
                ),
                _ => (200, r#"{"jsonrpc":"2.0","result":[],"id":999}"#.to_string()),
            }
        });
        let mut l = engine(port);
        let r = ask(&mut l, "POST", "tl_listProperties", Value::Null);
        assert_eq!(
            (r.status, r.body),
            (
                503,
                json!({"error": "unavailable", "capability": "tl_listproperties"})
            )
        );
        let r = ask(&mut l, "POST", "tl_getSyncStatus", Value::Null);
        assert_eq!(
            (r.status, r.body),
            (
                500,
                json!({"error": "backend", "capability": "tl_getsyncstatus"})
            )
        );
        let r = ask(&mut l, "POST", "tl_initmain", Value::Null);
        assert_eq!((r.status, r.body), (502, json!({"error": "transport"})));
        let r = ask(&mut l, "POST", "tl_getProperty", json!({"params": 3}));
        assert_eq!(r.status, 500);
        // an answer to some other request id is not an answer
        let r = ask(
            &mut l,
            "POST",
            "tl_getAllBalancesForAddress",
            json!({"params": "a"}),
        );
        assert_eq!((r.status, r.body), (502, json!({"error": "transport"})));
    }

    #[test]
    fn reply_validation() {
        assert_eq!(
            parse_reply(br#"{"jsonrpc":"2.0","result":1,"id":3}"#, 3),
            Outcome::Result(json!(1))
        );
        assert_eq!(
            parse_reply(
                br#"{"jsonrpc":"2.0","error":{"code":-32602,"message":"m"},"id":3}"#,
                3
            ),
            Outcome::Rpc(-32602)
        );
        for bad in [
            &br#"{"jsonrpc":"2.0","result":1,"id":4}"#[..],
            br#"{"jsonrpc":"1.0","result":1,"id":3}"#,
            br#"{"jsonrpc":"2.0","id":3}"#,
            br#"{"jsonrpc":"2.0","result":1,"error":{"code":1},"id":3}"#,
            br#"{"jsonrpc":"2.0","error":"x","id":3}"#,
            br#"[1]"#,
            b"not json",
            b"",
        ] {
            assert_eq!(
                parse_reply(bad, 3),
                Outcome::Malformed,
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
    }

    #[test]
    fn a_stopped_engine_is_an_axios_style_refusal() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let e = engine(port)
            .request("POST", "tl_getSyncStatus", "", None, T)
            .unwrap_err();
        assert_eq!(e, format!("connect ECONNREFUSED 127.0.0.1:{port}"));
    }

    #[test]
    fn an_engine_that_never_answers_times_out() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (st, _) = l.accept().unwrap();
            std::thread::sleep(Duration::from_millis(1500));
            drop(st);
        });
        let started = std::time::Instant::now();
        let e = engine(port)
            .request(
                "POST",
                "tl_getSyncStatus",
                "",
                None,
                Duration::from_millis(300),
            )
            .unwrap_err();
        assert_eq!(e, "timeout of 300ms exceeded");
        assert!(started.elapsed() < Duration::from_millis(1400));
        let _ = h.join();
    }

    // ---- amounts

    #[test]
    fn atoms_become_units_at_the_1e8_scale() {
        let n = |s: &str| atoms_to_units(&json!(s)).map(|n| n.to_string());
        assert_eq!(n("0").as_deref(), Some("0.0"));
        assert_eq!(n("1").as_deref(), Some("1e-8"));
        assert_eq!(n("100000000").as_deref(), Some("1.0"));
        assert_eq!(n("25000000000").as_deref(), Some("250.0"));
        assert_eq!(n("123456789").as_deref(), Some("1.23456789"));
        assert_eq!(n("000123").as_deref(), Some("1.23e-6"));
        for bad in ["", "-1", "1.5", "1e3", " 1", "0x10"] {
            assert!(n(bad).is_none(), "{bad:?}");
        }
        assert!(atoms_to_units(&json!(5)).is_none());
        // beyond u64: a finite number, not a failure
        assert!(n("340282366920938463463374607431768211455").is_some());
    }

    // ---- through the tlapi bridge (translate + the service), against the mock

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    /// `legacy::GATE_PORT`, the fixed port `translate` presents to the gate.
    const GATE_PORT: u16 = 1;

    fn service(l: RustEngineListener) -> WalletService {
        let token = SessionToken::from_hex(TOKEN).unwrap();
        let gate = Gate::new(GateConfig {
            port: GATE_PORT,
            token,
            allowed_origins: vec![ALLOWED_ORIGIN.to_string()],
            methods: MethodAllowlist::wallet_default(),
        });
        let table = crate::legacy::keyvault::KeyTable::shared();
        let secp = std::rc::Rc::new(bitcoin::secp256k1::Secp256k1::new());
        let conn = MemConnector::default();
        let mut svc = WalletService::new(
            gate,
            Box::new(crate::legacy::keyvault::HandleKeys::new(
                table.clone(),
                secp.clone(),
            )),
            Box::new(crate::legacy::keyvault::HandleSigner::new(
                crate::nodewallet::NodeWalletSigner::new(crate::nodewallet::NodeSlot::default()),
                table,
                secp,
            )),
            Box::new(MemStore::default()),
            Box::new(conn),
            Box::new(MemRelayer::default()),
            vec![],
            "/ltc".into(),
        );
        svc.set_listener(Box::new(l));
        svc
    }

    fn via_bridge(svc: &mut WalletService, method: &str, path: &str, body: &str) -> (u16, Value) {
        let req = http::Request::builder()
            .method(method)
            .uri(format!("http://tlapi.localhost{path}"))
            .header("Origin", ALLOWED_ORIGIN)
            .body(body.as_bytes().to_vec())
            .unwrap();
        let reply = match translate(&req, TOKEN) {
            Translated::Answer(a) => a,
            Translated::Forward(q) => handle_request(svc, &q),
            Translated::SocketIo => panic!("not a service request"),
        };
        let resp = reply.into_response();
        let v = serde_json::from_slice(resp.body()).unwrap_or(Value::Null);
        (resp.status().as_u16(), v)
    }

    #[test]
    fn the_bridge_serves_fe_speeds_routes_from_the_engine() {
        let (port, seen) = mock_rpcd(rpcd_reply);
        let mut svc = service(engine(port));
        // /tl/* (the UI's NewTradeLayerApiService, body `{params}`)
        let (s, b) = via_bridge(
            &mut svc,
            "POST",
            "/tl/getAllBalancesForAddress",
            r#"{"params":["carol"]}"#,
        );
        assert_eq!(s, 200);
        assert_eq!(b[0]["propertyId"], 7);
        assert_eq!(b[0]["available"], 250.0);
        let (s, b) = via_bridge(&mut svc, "POST", "/tl/listProperties", "{}");
        assert_eq!((s, b.as_array().map(Vec::len)), (200, Some(2)));
        let (s, b) = via_bridge(&mut svc, "POST", "/tl/getProperty", r#"{"params":[7]}"#);
        assert_eq!((s, &b["issuer"]), (200, &json!("alice")));
        let (s, b) = via_bridge(&mut svc, "POST", "/tl/getMaxProcessedHeight", "{}");
        assert_eq!((s, b), (200, json!({"maxProcessedHeight": 42})));
        let (s, b) = via_bridge(&mut svc, "POST", "/tl/init", "{}");
        assert_eq!(
            (s, b),
            (200, json!({"message": "TL Main initialized successfully"}))
        );
        // /tlraw/* passthrough
        let (s, b) = via_bridge(&mut svc, "POST", "/tlraw/tl_getSyncStatus", "{}");
        assert_eq!((s, &b["consensus"]), (200, &json!(42)));
        let (s, b) = via_bridge(
            &mut svc,
            "POST",
            "/tlraw/tl_getAllBalancesForAddress",
            r#"{"params":"carol"}"#,
        );
        assert_eq!((s, b.as_array().map(Vec::len)), (200, Some(2)));
        // unavailable: the listener's 503 shape through /tlraw, a 500 'Error:' through /tl
        let (s, b) = via_bridge(
            &mut svc,
            "GET",
            "/tlraw/tl_contractPosition?address=a&contractId=3",
            "",
        );
        assert_eq!(
            (s, b),
            (
                503,
                json!({"error": "unavailable", "capability": "contract_positions"})
            )
        );
        let (s, _) = via_bridge(
            &mut svc,
            "POST",
            "/tl/getAttestations",
            r#"{"params":["a",0]}"#,
        );
        assert_eq!(s, 500);
        let sent = methods(&seen);
        assert!(
            !sent
                .iter()
                .any(|m| m.contains("contract") || m.contains("attest")),
            "{sent:?}"
        );
    }

    #[test]
    fn the_default_listener_is_still_the_http_passthrough_through_the_bridge() {
        // a plain HTTP listener answering FE-speed's shape, no tl_engine configured
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut st, _) = l.accept().unwrap();
            let raw = read_request(&mut st);
            let body = br#"[{"propertyId":1}]"#;
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = st.write_all(head.as_bytes());
            let _ = st.write_all(body);
            String::from_utf8_lossy(&raw).into_owned()
        });
        let l = listener_for(
            &EngineSettings::default(),
            &format!("http://127.0.0.1:{port}"),
        )
        .unwrap();
        let mut svc = service(engine(1));
        svc.set_listener(l);
        let (s, b) = via_bridge(
            &mut svc,
            "POST",
            "/tlraw/tl_getAllBalancesForAddress",
            r#"{"params":"a"}"#,
        );
        assert_eq!((s, b), (200, json!([{"propertyId": 1}])));
        let raw = h.join().unwrap();
        assert!(
            raw.starts_with("POST /tl_getAllBalancesForAddress HTTP/1.1"),
            "{raw}"
        );
    }
}
