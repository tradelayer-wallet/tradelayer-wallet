//! The HTTP route table of `wallet-server` (`routes/keys.route.ts`, `routes/main.route.ts`) behind
//! the gate. Transport (an HTTP listener bound to loopback) is an adapter: it builds an
//! `HttpRequest` from the socket and writes the returned `HttpResponse`. All node, key, signing and
//! file-system access goes through the traits below; tests use the in-memory doubles in `mem`.
//!
//! Response shapes are the legacy ones: `{ "data": ... }` on success, `{ "error": "..." }` on
//! failure; 200 on success, 500 for handler errors (legacy), plus 401/403/404/405/413 from the gate.

use crate::amount::Amount;
use crate::gate::{Deny, Gate, RequestMeta};
use crate::nodecfg::{
    is_testnet, launch_args, parse_conf, render_conf, rpc_endpoint, validate_endpoint,
    validate_new_config, validate_path, LaunchOptions, RpcEndpoint,
};
use crate::psbt::{build_psbt, guard_psbt, guard_sign, psbt_input_count, UtxoView};
use crate::txbuilder::{
    fee_for_inputs, merged_outputs, plan_instant_trade, plan_payment, InstantTradeRequest,
    PaymentRequest, Utxo, MAX_INPUTS,
};
use serde_json::{json, Map, Value};

pub const MAX_BODY_BYTES: usize = 1 << 20;
/// Absolute ceiling for a caller-approved `maxFee` (1 coin).
pub const ABSOLUTE_MAX_FEE_SAT: u64 = 100_000_000;
const NETWORKS: [&str; 4] = ["LTC", "LTCTEST", "BTC", "BTCTEST"];

pub type CallResult = Result<Value, String>;

pub trait RpcBackend {
    fn call(&mut self, method: &str, params: &[Value]) -> CallResult;
}

/// Remote relayer API (`axios.post(url + '/rpc/' + method, { params })`).
pub trait RelayerBackend {
    fn call(&mut self, base_url: &str, method: &str, params: &[Value]) -> CallResult;
}

pub trait KeyBackend {
    fn new_mnemonic(&mut self, network: &str) -> Result<String, String>;
    /// `{ address, privkey, pubkey, wif }`
    fn key_pair(&mut self, network: &str, mnemonic: &str, path: &str) -> CallResult;
}

pub trait SignBackend {
    fn sign_tx(&mut self, network: &str, rawtx: &str, wif: &str, inputs: &[Utxo]) -> CallResult;
    fn sign_psbt(&mut self, network: &str, wif: &str, psbt_hex: &str) -> CallResult;
}

pub trait ConfStore {
    fn dir_exists(&self, dir: &str) -> bool;
    fn file_exists(&self, path: &str) -> bool;
    fn read(&self, path: &str) -> Option<String>;
    /// Create a new file; must fail if it already exists.
    fn write_new(&mut self, path: &str, contents: &str) -> Result<(), String>;
}

pub trait NodeConnector {
    fn connect(&mut self, ep: &RpcEndpoint, testnet: bool) -> Result<Box<dyn RpcBackend>, String>;
}

#[derive(Clone, Debug)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub peer_is_loopback: bool,
    pub host: Option<String>,
    pub origin: Option<String>,
    pub token: Option<String>,
    pub body_len: usize,
    pub body: Value,
}

impl HttpRequest {
    pub fn post(path: &str, token: &str, body: Value) -> HttpRequest {
        HttpRequest {
            method: "POST".into(),
            path: path.into(),
            peer_is_loopback: true,
            host: None,
            origin: None,
            token: Some(token.into()),
            body_len: body.to_string().len(),
            body,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Value,
    /// Value for `Access-Control-Allow-Origin`; `None` means no CORS headers at all.
    pub allow_origin: Option<String>,
}

fn ok(data: Value) -> (u16, Value) {
    (200, json!({ "data": data }))
}

fn fail(status: u16, msg: impl Into<String>) -> (u16, Value) {
    (status, json!({ "error": msg.into() }))
}

pub struct WalletService {
    gate: Gate,
    keys: Box<dyn KeyBackend>,
    signer: Box<dyn SignBackend>,
    store: Box<dyn ConfStore>,
    connector: Box<dyn NodeConnector>,
    relayer: Box<dyn RelayerBackend>,
    allowed_relayer_hosts: Vec<String>,
    default_dir: String,
    node: Option<Box<dyn RpcBackend>>,
    relayer_url: Option<String>,
}

struct RpcView<'a>(&'a mut dyn RpcBackend);

impl UtxoView for RpcView<'_> {
    fn amount_of(&mut self, txid: &str, vout: u32) -> Option<Amount> {
        let r = self
            .0
            .call("gettxout", &[json!(txid), json!(vout), json!(true)])
            .ok()?;
        Amount::from_coin_f64(r.get("value")?.as_f64()?).ok()
    }
}

fn parse_utxo(v: &Value) -> Result<Utxo, String> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let txid = s("txid").ok_or("input.txid missing")?;
    if txid.len() != 64 || !txid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("input.txid malformed".into());
    }
    let vout = v
        .get("vout")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or("input.vout malformed")?;
    let amount = v
        .get("amount")
        .and_then(Value::as_f64)
        .ok_or("input.amount missing")?;
    let amount = Amount::from_coin_f64(amount).map_err(|e| format!("input.amount: {e}"))?;
    Ok(Utxo {
        txid: txid.to_ascii_lowercase(),
        vout,
        amount,
        confirmations: v
            .get("confirmations")
            .and_then(Value::as_u64)
            .map(|c| c.min(u32::MAX as u64) as u32)
            .unwrap_or(0),
        script_pub_key: s("scriptPubKey").unwrap_or_default(),
        redeem_script: s("redeemScript"),
        pubkey: s("pubkey"),
    })
}

fn parse_utxos(v: Option<&Value>) -> Result<Vec<Utxo>, String> {
    match v {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(a)) if a.len() <= MAX_INPUTS => a.iter().map(parse_utxo).collect(),
        Some(_) => Err("inputs malformed or too many".into()),
    }
}

fn utxo_json(u: &Utxo) -> Value {
    let mut m = Map::new();
    m.insert("txid".into(), json!(u.txid));
    m.insert("vout".into(), json!(u.vout));
    m.insert("amount".into(), u.amount.to_json_number());
    m.insert("confirmations".into(), json!(u.confirmations));
    m.insert("scriptPubKey".into(), json!(u.script_pub_key));
    if let Some(r) = &u.redeem_script {
        m.insert("redeemScript".into(), json!(r));
    }
    if let Some(p) = &u.pubkey {
        m.insert("pubkey".into(), json!(p));
    }
    Value::Object(m)
}

fn req_str<'a>(b: &'a Value, k: &str) -> Result<&'a str, String> {
    b.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{k} missing"))
}

fn check_network(n: &str) -> Result<(), String> {
    if NETWORKS.contains(&n) {
        Ok(())
    } else {
        Err("Network not found!".into())
    }
}

fn check_hex(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.len().is_multiple_of(2) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn check_address(a: &str) -> Result<(), String> {
    if !a.is_empty() && a.len() <= 100 && a.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        Err("address malformed".into())
    }
}

fn check_derivation_path(p: &str) -> Result<(), String> {
    let mut parts = p.split('/');
    if parts.next() != Some("m") {
        return Err("derivation path malformed".into());
    }
    let mut n = 0;
    for seg in parts {
        let digits = seg.strip_suffix(['\'', 'h']).unwrap_or(seg);
        if digits.is_empty()
            || digits.len() > 10
            || !digits.bytes().all(|b| b.is_ascii_digit())
            || digits.parse::<u64>().map_or(true, |v| v >= 1 << 31)
        {
            return Err("derivation path malformed".into());
        }
        n += 1;
        if n > 10 {
            return Err("derivation path too long".into());
        }
    }
    Ok(())
}

fn check_mnemonic(m: &str) -> Result<(), String> {
    let words = m.split(' ').count();
    if m.len() <= 512
        && (12..=24).contains(&words)
        && m.bytes().all(|b| b.is_ascii_lowercase() || b == b' ')
    {
        Ok(())
    } else {
        Err("mnemonic malformed".into())
    }
}

impl WalletService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        gate: Gate,
        keys: Box<dyn KeyBackend>,
        signer: Box<dyn SignBackend>,
        store: Box<dyn ConfStore>,
        connector: Box<dyn NodeConnector>,
        relayer: Box<dyn RelayerBackend>,
        allowed_relayer_hosts: Vec<String>,
        default_dir: String,
    ) -> WalletService {
        WalletService {
            gate,
            keys,
            signer,
            store,
            connector,
            relayer,
            allowed_relayer_hosts,
            default_dir,
            node: None,
            relayer_url: None,
        }
    }

    pub fn node_connected(&self) -> bool {
        self.node.is_some()
    }

    pub fn relayer_url(&self) -> Option<&str> {
        self.relayer_url.as_deref()
    }

    pub fn handle(&mut self, req: &HttpRequest) -> HttpResponse {
        let meta = RequestMeta {
            peer_is_loopback: req.peer_is_loopback,
            host: req.host.as_deref(),
            origin: req.origin.as_deref(),
            token: req.token.as_deref(),
        };
        let allow_origin = self.gate.cors_allow_origin(req.origin.as_deref());
        if req.method == "OPTIONS" {
            return match self.gate.check_preflight(&meta) {
                Ok(()) => HttpResponse {
                    status: 204,
                    body: Value::Null,
                    allow_origin,
                },
                Err(d) => denied(d),
            };
        }
        if let Err(d) = self.gate.check(&meta) {
            return denied(d);
        }
        let (status, body) = if req.method != "POST" {
            fail(405, "method not allowed")
        } else if req.body_len > MAX_BODY_BYTES {
            fail(413, "body too large")
        } else {
            self.route(&req.path, &req.body)
        };
        HttpResponse {
            status,
            body,
            allow_origin,
        }
    }

    fn route(&mut self, path: &str, b: &Value) -> (u16, Value) {
        let r: Result<(u16, Value), String> = match path {
            "/keys/new-wallet" => self.new_wallet(b),
            "/keys/get-address" => self.get_address(b),
            "/keys/get-address-file" => self.get_address_file(b),
            "/api/rpc-call" => self.rpc_call(b),
            "/api/start-wallet-node" => self.start_wallet_node(b),
            "/api/stop-wallet-node" => self.stop_wallet_node(),
            "/api/new-config" => self.new_config(b),
            "/api/build-tx" => self.build_tx(b),
            "/api/build-ltcit-tx" => self.build_ltcit_tx(b),
            "/api/sign-tx" => self.sign_tx(b),
            "/api/sign-psbt" => self.sign_psbt(b),
            "/api/set-api-url" => self.set_api_url(b),
            _ => return fail(404, "not found"),
        };
        match r {
            Ok(v) => v,
            Err(e) => fail(500, e),
        }
    }

    // ---- keys ----

    fn new_wallet(&mut self, b: &Value) -> Result<(u16, Value), String> {
        let n = req_str(b, "network")?;
        check_network(n)?;
        Ok((200, json!({ "mnemonic": self.keys.new_mnemonic(n)? })))
    }

    fn get_address(&mut self, b: &Value) -> Result<(u16, Value), String> {
        let n = req_str(b, "network")?;
        check_network(n)?;
        let m = req_str(b, "mnemonic")?;
        check_mnemonic(m)?;
        let p = req_str(b, "derivatePath")?;
        check_derivation_path(p)?;
        // Legacy returned the bare object (no `data` wrapper) for the key routes.
        Ok((200, self.keys.key_pair(n, m, p)?))
    }

    fn get_address_file(&mut self, b: &Value) -> Result<(u16, Value), String> {
        let n = req_str(b, "network")?;
        check_network(n)?;
        let m = req_str(b, "mnemonic")?;
        check_mnemonic(m)?;
        let obj = b
            .get("walletObjRaw")
            .and_then(Value::as_object)
            .ok_or("walletObjRaw missing")?;
        let total: usize = obj.values().filter_map(Value::as_array).map(Vec::len).sum();
        if obj.len() > 64 || total > 256 {
            return Err("walletObjRaw too large".into());
        }
        let mut out = Map::new();
        for (label, paths) in obj {
            let arr = paths.as_array().ok_or("walletObjRaw malformed")?;
            let mut keys = Vec::new();
            for p in arr {
                let p = p.as_str().ok_or("derivation path malformed")?;
                check_derivation_path(p)?;
                keys.push(self.keys.key_pair(n, m, p)?);
            }
            out.insert(label.clone(), Value::Array(keys));
        }
        Ok((200, Value::Object(out)))
    }

    // ---- rpc ----

    fn rpc_call(&mut self, b: &Value) -> Result<(u16, Value), String> {
        let method = req_str(b, "method")?;
        let params: Vec<Value> = match b.get("params") {
            None | Some(Value::Null) => vec![],
            Some(Value::Array(a)) => a.clone(),
            Some(_) => return Err("params must be an array".into()),
        };
        if let Err(d) = self.gate.check_rpc(method, params.len()) {
            return Ok(fail(d.status(), format!("rpc method denied: {d:?}")));
        }
        let node = self.node.as_mut().ok_or("No RPC Client initialized")?;
        Ok(ok(node.call(method, &params)?))
    }

    fn smart_rpc(&mut self, method: &str, params: &[Value], api: bool) -> CallResult {
        if let (Some(node), false) = (self.node.as_mut(), api) {
            return node.call(method, params);
        }
        match &self.relayer_url {
            Some(u) => self.relayer.call(u, method, params),
            None => Err("Relayer API url not found".into()),
        }
    }

    fn set_api_url(&mut self, b: &Value) -> Result<(u16, Value), String> {
        match b.get("apiUrl") {
            None | Some(Value::Null) => self.relayer_url = None,
            Some(Value::String(u)) => {
                let ep = validate_endpoint(u, &self.allowed_relayer_hosts)
                    .map_err(|e| format!("apiUrl rejected: {e}"))?;
                self.relayer_url = Some(ep.url);
            }
            Some(_) => return Err("apiUrl must be a string or null".into()),
        }
        Ok(ok(json!(true)))
    }

    // ---- node ----

    fn resolve_dir(&self, path: Option<&str>) -> Result<String, String> {
        match path {
            Some(p) if !p.is_empty() => {
                validate_path(p).map_err(|e| e.to_string())?;
                Ok(p.to_string())
            }
            _ => Ok(self.default_dir.clone()),
        }
    }

    fn start_wallet_node(&mut self, b: &Value) -> Result<(u16, Value), String> {
        let testnet = is_testnet(req_str(b, "network")?).map_err(|e| e.to_string())?;
        let dir = self.resolve_dir(b.get("path").and_then(Value::as_str))?;
        let opts = LaunchOptions {
            testnet,
            startclean: b
                .get("startclean")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            reindex: b.get("reindex").and_then(Value::as_bool).unwrap_or(false),
            datadir: b.get("path").and_then(Value::as_str).map(str::to_string),
        };
        // Validates the launch arguments (the legacy exec of the bundled node is disabled).
        launch_args(&opts).map_err(|e| e.to_string())?;
        let conf_path = format!("{}/litecoin.conf", dir.trim_end_matches(['/', '\\']));
        let text = self
            .store
            .read(&conf_path)
            .ok_or_else(|| format!("Config file (litecoin.conf) doesn't exist in: {dir}"))?;
        let ep = rpc_endpoint(&parse_conf(&text), testnet)
            .map_err(|_| format!("Incorrect Config File {dir}"))?;
        let client = self.connector.connect(&ep, testnet)?;
        self.node = Some(client);
        Ok(ok(json!({ "data": true })))
    }

    fn stop_wallet_node(&mut self) -> Result<(u16, Value), String> {
        if let Some(node) = self.node.as_mut() {
            node.call("stop", &[])?;
        }
        self.node = None;
        Ok(ok(json!(true)))
    }

    fn new_config(&mut self, b: &Value) -> Result<(u16, Value), String> {
        let cfg = validate_new_config(
            req_str(b, "username")?,
            req_str(b, "password")?,
            b.get("port")
                .and_then(Value::as_i64)
                .ok_or("port missing")?,
            b.get("path")
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty()),
        )
        .map_err(|e| e.to_string())?;
        let dir = self.resolve_dir(cfg.path.as_deref())?;
        if !self.store.dir_exists(&dir) {
            return Err("Provided Directory Dont exist".into());
        }
        let file = format!("{}/litecoin.conf", dir.trim_end_matches(['/', '\\']));
        if self.store.file_exists(&file) {
            return Err("litecoin.conf file Already exist in provided directory!".into());
        }
        self.store.write_new(&file, &render_conf(&cfg))?;
        Ok(ok(json!("litecoin.conf file was created")))
    }

    // ---- tx building ----

    fn validate_address(&mut self, addr: &str, api: bool) -> Result<(), String> {
        check_address(addr)?;
        let r = self.smart_rpc("validateaddress", &[json!(addr)], api)?;
        if r.get("isvalid").and_then(Value::as_bool) == Some(true) {
            Ok(())
        } else {
            Err("validateaddress: invalid address".into())
        }
    }

    fn min_vout_amount(&mut self, to: &str, api: bool) -> Result<Amount, String> {
        let raw = self.smart_rpc("tl_createrawtx_reference", &[json!(""), json!(to)], api)?;
        let raw = raw
            .as_str()
            .ok_or("tl_createrawtx_reference: no data")?
            .to_string();
        let dec = self.smart_rpc("decoderawtransaction", &[json!(raw)], api)?;
        let v = dec
            .get("vout")
            .and_then(|v| v.get(0))
            .and_then(|o| o.get("value"))
            .and_then(Value::as_f64)
            .ok_or("decoderawtransaction: no vout")?;
        let a = Amount::from_coin_f64(v).map_err(|e| e.to_string())?;
        if a.sat() == 0 {
            return Err("getMinVoutAmount: zero".into());
        }
        Ok(a)
    }

    fn list_unspent(&mut self, addr: &str, pubkey: Option<&str>) -> Result<Vec<Utxo>, String> {
        // Always through the relayer API, as in the legacy builder.
        let r = self.smart_rpc(
            "listunspent",
            &[json!(0), json!(999_999_999), json!([addr])],
            true,
        )?;
        let arr = r.as_array().ok_or("listunspent: no data")?;
        if arr.len() > 10_000 {
            return Err("listunspent: too many outputs".into());
        }
        let mut out = Vec::with_capacity(arr.len());
        for v in arr {
            let mut u = parse_utxo(v)?;
            u.pubkey = pubkey.map(str::to_string);
            out.push(u);
        }
        Ok(out)
    }

    fn create_raw(
        &mut self,
        inputs: &[Utxo],
        outs: &[(String, Amount)],
        api: bool,
    ) -> Result<String, String> {
        let ins: Vec<Value> = inputs
            .iter()
            .map(|u| json!({ "txid": u.txid, "vout": u.vout }))
            .collect();
        let mut o = Map::new();
        for (a, v) in outs {
            o.insert(a.clone(), v.to_json_number());
        }
        let r = self.smart_rpc(
            "createrawtransaction",
            &[Value::Array(ins), Value::Object(o)],
            api,
        )?;
        r.as_str()
            .map(str::to_string)
            .ok_or_else(|| "createrawtransaction: no data".into())
    }

    fn add_payload(&mut self, raw: &str, payload: &str, api: bool) -> Result<String, String> {
        let r = self.smart_rpc(
            "tl_createrawtx_opreturn",
            &[json!(raw), json!(payload)],
            api,
        )?;
        r.as_str()
            .map(str::to_string)
            .ok_or_else(|| "tl_createrawtx_opreturn: no data".into())
    }

    fn build_tx(&mut self, b: &Value) -> Result<(u16, Value), String> {
        let api = b.get("isApiMode").and_then(Value::as_bool).unwrap_or(false);
        let from = b
            .get("fromKeyPair")
            .and_then(|k| k.get("address"))
            .and_then(Value::as_str)
            .ok_or("fromKeyPair.address missing")?
            .to_string();
        let from_pub = b
            .get("fromKeyPair")
            .and_then(|k| k.get("pubkey"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let to = b
            .get("toKeyPair")
            .and_then(|k| k.get("address"))
            .and_then(Value::as_str)
            .ok_or("toKeyPair.address missing")?
            .to_string();
        let amount = match b.get("amount") {
            None | Some(Value::Null) => None,
            Some(v) => Some(
                Amount::from_coin_f64(v.as_f64().ok_or("amount malformed")?)
                    .map_err(|e| format!("amount: {e}"))?,
            ),
        };
        let payload = b
            .get("payload")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty());
        if let Some(p) = payload {
            if !check_hex(p, 8192) {
                return Err("payload must be hex".into());
            }
        }
        let supplied = parse_utxos(b.get("inputs"))?;
        let add_psbt = b.get("addPsbt").and_then(Value::as_bool).unwrap_or(false);
        let network = b.get("network").and_then(Value::as_str).unwrap_or("LTC");
        check_network(network)?;

        self.validate_address(&from, api)?;
        self.validate_address(&to, api)?;
        let wallet = self.list_unspent(&from, from_pub.as_deref())?;
        let min_out = self.min_vout_amount(&to, api)?;
        let plan = plan_payment(&PaymentRequest {
            amount,
            has_payload: payload.is_some(),
            min_out,
            supplied: &supplied,
            wallet: &wallet,
        })
        .map_err(|e| e.to_string())?;
        let outs = merged_outputs(&[(to.clone(), plan.to_amount), (from.clone(), plan.change)])
            .map_err(|e| e.to_string())?;
        let mut raw = self.create_raw(&plan.inputs, &outs, api)?;
        if let Some(p) = payload {
            raw = self.add_payload(&raw, p, api)?;
        }
        let mut data = Map::new();
        data.insert("rawtx".into(), json!(raw));
        data.insert(
            "inputs".into(),
            Value::Array(plan.inputs.iter().map(utxo_json).collect()),
        );
        if add_psbt {
            data.insert(
                "psbtHex".into(),
                json!(build_psbt(&raw, &plan.inputs).map_err(|e| format!("buildPsbt: {e}"))?),
            );
        }
        Ok(ok(Value::Object(data)))
    }

    fn build_ltcit_tx(&mut self, b: &Value) -> Result<(u16, Value), String> {
        let api = b.get("isApiMode").and_then(Value::as_bool).unwrap_or(false);
        let kp = |k: &str| -> Result<(String, Option<String>), String> {
            let o = b.get(k).ok_or_else(|| format!("{k} missing"))?;
            let a = o
                .get("address")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{k}.address missing"))?;
            Ok((
                a.to_string(),
                o.get("pubkey").and_then(Value::as_str).map(str::to_string),
            ))
        };
        let (buyer, buyer_pub) = kp("buyerKeyPair")?;
        let (seller, _) = kp("sellerKeyPair")?;
        let amount = Amount::from_coin_f64(
            b.get("amount")
                .and_then(Value::as_f64)
                .ok_or("amount missing")?,
        )
        .map_err(|e| format!("amount: {e}"))?;
        let payload = req_str(b, "payload")?;
        if !check_hex(payload, 8192) {
            return Err("payload must be hex".into());
        }
        let commit = parse_utxos(b.get("commitUTXOs"))?;
        let network = req_str(b, "network")?;
        check_network(network)?;

        self.validate_address(&buyer, api)?;
        self.validate_address(&seller, api)?;
        let wallet = self.list_unspent(&buyer, buyer_pub.as_deref())?;
        let min_out = self.min_vout_amount(&seller, api)?;
        let plan = plan_instant_trade(&InstantTradeRequest {
            amount,
            min_out,
            commit_utxos: &commit,
            wallet: &wallet,
        })
        .map_err(|e| e.to_string())?;
        let outs = merged_outputs(&[
            (buyer.clone(), plan.buyer_change),
            (seller.clone(), plan.seller_amount),
        ])
        .map_err(|e| e.to_string())?;
        let raw = self.create_raw(&plan.inputs, &outs, api)?;
        let raw = self.add_payload(&raw, payload, api)?;
        let psbt = build_psbt(&raw, &plan.inputs).map_err(|e| format!("buildPsbt: {e}"))?;
        Ok(ok(json!({
            "rawtx": raw,
            "inputs": plan.inputs.iter().map(utxo_json).collect::<Vec<_>>(),
            "psbtHex": psbt,
        })))
    }

    // ---- signing ----

    /// Caller-approved fee ceiling, if any (decimal string, capped at `ABSOLUTE_MAX_FEE_SAT`).
    fn approved_fee(b: &Value) -> Result<Option<Amount>, String> {
        match b.get("maxFee") {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => {
                let a = Amount::parse_coin(s).map_err(|e| format!("maxFee: {e}"))?;
                if a.sat() > ABSOLUTE_MAX_FEE_SAT {
                    Err("maxFee above absolute ceiling".into())
                } else {
                    Ok(Some(a))
                }
            }
            Some(_) => Err("maxFee must be a decimal string".into()),
        }
    }

    fn max_fee(approved: Option<Amount>, n_inputs: usize) -> Result<Amount, String> {
        match approved {
            Some(a) => Ok(a),
            None => fee_for_inputs(n_inputs).map_err(|e| e.to_string()),
        }
    }

    fn sign_tx(&mut self, b: &Value) -> Result<(u16, Value), String> {
        let rawtx = req_str(b, "rawtx")?;
        let wif = req_str(b, "wif")?;
        let network = req_str(b, "network")?;
        check_network(network)?;
        let inputs = parse_utxos(b.get("inputs"))?;
        let approved = Self::approved_fee(b)?;
        let tx = crate::psbt::decode_tx(rawtx).map_err(|e| e.to_string())?;
        let max_fee = Self::max_fee(approved, tx.input.len())?;
        let node = self.node.as_mut().ok_or("No RPC Client initialized")?;
        guard_sign(rawtx, &inputs, &mut RpcView(node.as_mut()), max_fee)
            .map_err(|e| format!("sign guard: {e}"))?;
        Ok(ok(self.signer.sign_tx(network, rawtx, wif, &inputs)?))
    }

    fn sign_psbt(&mut self, b: &Value) -> Result<(u16, Value), String> {
        let wif = req_str(b, "wif")?;
        let network = req_str(b, "network")?;
        check_network(network)?;
        let psbt_hex = req_str(b, "psbtHex")?;
        let approved = Self::approved_fee(b)?;
        let n_inputs = psbt_input_count(psbt_hex).map_err(|e| e.to_string())?;
        let max_fee = Self::max_fee(approved, n_inputs)?;
        let node = self.node.as_mut().ok_or("No RPC Client initialized")?;
        guard_psbt(psbt_hex, &mut RpcView(node.as_mut()), max_fee)
            .map_err(|e| format!("sign guard: {e}"))?;
        Ok(ok(self.signer.sign_psbt(network, wif, psbt_hex)?))
    }
}
fn denied(d: Deny) -> HttpResponse {
    HttpResponse {
        status: d.status(),
        body: json!({ "error": format!("denied: {d:?}") }),
        allow_origin: None,
    }
}
