//! Node-wallet signing for the legacy bridge.
//!
//! wallet-fe is a node-wallet UI: its addresses live in the node's wallet (label `tl-wallet`) and
//! the page never holds a key. The swapper therefore posts `wif: ""` to `/api/sign-tx` and
//! `/api/sign-psbt`, and [`NodeWalletSigner`] has the node sign:
//!
//! * `sign-tx`: `signrawtransactionwithwallet [rawtx, prevtxs]`, with `prevtxs` built from the
//!   inputs the service guard already bound to the chain (`gettxout` amounts, fee ceiling);
//!   `{hex, complete}` becomes `{isValid: complete, signedHex: hex, isFinished: complete}`.
//! * `sign-psbt`: `walletprocesspsbt [psbt (base64), true, "ALL", true]`, then `finalizepsbt` when the
//!   node reports the PSBT complete; the reply is `{psbtHex, isValid, isFinished, finalHex?}`. The UI
//!   speaks hex PSBTs (legacy bitcoinjs), the node speaks base64, so the signer converts both ways.
//!
//! A non-empty WIF is refused before any RPC: the desktop build never signs with a page-supplied
//! key. The key routes stay refused as well (`legacy::RefuseKeys`).
//!
//! ## Which node, which wallet
//!
//! The signer calls the same client the service uses for `rpc-call` ([`SharedConnector`] hands the
//! service a handle to the connection it keeps for the signer). Legacy `wallet-server` made every
//! node call, wallet calls included, on the default wallet URL (`/`), and wallet-fe's own address
//! calls (`getaddressesbylabel`, `getnewaddress`) go through that same client, so signing uses the
//! wallet those calls see. When `start-wallet-node` replaces the connection or `stop-wallet-node`
//! drops it, the signer's weak handle expires with it.

use serde_json::{json, Value};
use std::cell::RefCell;
use std::rc::{Rc, Weak};
use tl_wallet_service::nodecfg::RpcEndpoint;
use tl_wallet_service::service::{CallResult, NodeConnector, RpcBackend, SignBackend};
use tl_wallet_service::txbuilder::Utxo;

pub const WIF_REFUSED: &str = "WIF signing is disabled in the desktop build; the node wallet signs";
const NO_NODE: &str = "No RPC Client initialized";
/// Both hex strings the service accepts are capped at 400k characters; the same bound here keeps
/// the base64 conversion bounded.
const MAX_PSBT_HEX_CHARS: usize = 400_000;

type Shared = Rc<RefCell<Box<dyn RpcBackend>>>;
type Handle = Weak<RefCell<Box<dyn RpcBackend>>>;

/// Weak handle to the connection the service currently holds.
#[derive(Clone, Default)]
pub struct NodeSlot(Rc<RefCell<Handle>>);

impl NodeSlot {
    fn set(&self, node: &Shared) {
        *self.0.borrow_mut() = Rc::downgrade(node);
    }

    fn call(&self, method: &str, params: &[Value]) -> CallResult {
        let node = self.0.borrow().upgrade().ok_or(NO_NODE)?;
        let mut client = node
            .try_borrow_mut()
            .map_err(|_| "node client busy".to_string())?;
        client.call(method, params)
    }
}

/// The service's handle: forwards every call to the shared client.
struct SharedRpc(Shared);

impl RpcBackend for SharedRpc {
    fn call(&mut self, method: &str, params: &[Value]) -> CallResult {
        self.0
            .try_borrow_mut()
            .map_err(|_| "node client busy".to_string())?
            .call(method, params)
    }
}

/// Wraps a [`NodeConnector`]: the client it builds is shared with the signer through `slot`.
pub struct SharedConnector<C: NodeConnector> {
    inner: C,
    slot: NodeSlot,
}

impl<C: NodeConnector> SharedConnector<C> {
    pub fn new(inner: C, slot: NodeSlot) -> SharedConnector<C> {
        SharedConnector { inner, slot }
    }
}

impl<C: NodeConnector> NodeConnector for SharedConnector<C> {
    fn connect(&mut self, ep: &RpcEndpoint, testnet: bool) -> Result<Box<dyn RpcBackend>, String> {
        let shared: Shared = Rc::new(RefCell::new(self.inner.connect(ep, testnet)?));
        self.slot.set(&shared);
        Ok(Box::new(SharedRpc(shared)))
    }
}

/// `SignBackend` that has the node wallet sign. Accepts only `wif == ""`.
pub struct NodeWalletSigner {
    node: NodeSlot,
}

impl NodeWalletSigner {
    pub fn new(node: NodeSlot) -> NodeWalletSigner {
        NodeWalletSigner { node }
    }
}

/// `prevtxs` for `signrawtransactionwithwallet`: the node's `scriptPubKey` and amount per input,
/// plus the multisig script as `witnessScript` for channel inputs. An input without a
/// `scriptPubKey` is left to the wallet's own coin records.
fn prevtxs(inputs: &[Utxo]) -> Result<Value, String> {
    let mut out = Vec::with_capacity(inputs.len());
    for u in inputs {
        if u.script_pub_key.is_empty() {
            continue;
        }
        hex_to_bytes(&u.script_pub_key).map_err(|_| "input.scriptPubKey malformed".to_string())?;
        let mut o = json!({
            "txid": u.txid,
            "vout": u.vout,
            "scriptPubKey": u.script_pub_key,
            "amount": u.amount.to_json_number(),
        });
        if let Some(rs) = &u.redeem_script {
            hex_to_bytes(rs).map_err(|_| "input.redeemScript malformed".to_string())?;
            o["witnessScript"] = json!(rs);
        }
        out.push(o);
    }
    Ok(Value::Array(out))
}

fn str_field<'a>(v: &'a Value, k: &str, what: &str) -> Result<&'a str, String> {
    v.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{what}: no {k}"))
}

fn flag(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

impl SignBackend for NodeWalletSigner {
    fn sign_tx(&mut self, _network: &str, rawtx: &str, wif: &str, inputs: &[Utxo]) -> CallResult {
        if !wif.is_empty() {
            return Err(WIF_REFUSED.into());
        }
        let prev = prevtxs(inputs)?;
        let r = self
            .node
            .call("signrawtransactionwithwallet", &[json!(rawtx), prev])?;
        let hex = str_field(&r, "hex", "signrawtransactionwithwallet")?;
        let complete = flag(&r, "complete");
        Ok(json!({ "isValid": complete, "signedHex": hex, "isFinished": complete }))
    }

    fn sign_psbt(&mut self, _network: &str, wif: &str, psbt_hex: &str) -> CallResult {
        if !wif.is_empty() {
            return Err(WIF_REFUSED.into());
        }
        if psbt_hex.len() > MAX_PSBT_HEX_CHARS {
            return Err("psbtHex too large".into());
        }
        let b64_in = b64_encode(&hex_to_bytes(psbt_hex).map_err(|_| "psbtHex malformed")?);
        let r = self.node.call(
            "walletprocesspsbt",
            &[json!(b64_in), json!(true), json!("ALL"), json!(true)],
        )?;
        let b64_out = str_field(&r, "psbt", "walletprocesspsbt")?;
        let psbt_out =
            bytes_to_hex(&b64_decode(b64_out).map_err(|_| "walletprocesspsbt: psbt malformed")?);
        let complete = flag(&r, "complete");
        // A partial PSBT counts as signed when the node changed it (it added a signature).
        let mut out = json!({
            "psbtHex": psbt_out,
            "isValid": complete || b64_out != b64_in,
            "isFinished": false,
        });
        if complete {
            let f = self
                .node
                .call("finalizepsbt", &[json!(b64_out), json!(true)])?;
            if flag(&f, "complete") {
                if let Some(h) = f.get("hex").and_then(Value::as_str) {
                    out["isFinished"] = json!(true);
                    out["finalHex"] = json!(h);
                }
            }
        }
        Ok(out)
    }
}

// ------------------------------------------------------------------ encodings

fn hex_to_bytes(s: &str) -> Result<Vec<u8>, ()> {
    if s.is_empty() || !s.len().is_multiple_of(2) {
        return Err(());
    }
    s.as_bytes()
        .chunks(2)
        .map(|c| {
            let d = |b: u8| (b as char).to_digit(16).map(|v| v as u8);
            Ok(d(c[0]).ok_or(())? << 4 | d(c[1]).ok_or(())?)
        })
        .collect()
}

fn bytes_to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        s.push(B64[(n >> 18) as usize & 63] as char);
        s.push(B64[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        s.push(if c.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    s
}

/// Standard alphabet, padding required, no whitespace.
fn b64_decode(s: &str) -> Result<Vec<u8>, ()> {
    let b = s.as_bytes();
    if b.is_empty() || !b.len().is_multiple_of(4) {
        return Err(());
    }
    let val = |c: u8| B64.iter().position(|x| *x == c).map(|p| p as u32);
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    let last = b.len() / 4 - 1;
    for (i, c) in b.chunks(4).enumerate() {
        let pad = c.iter().rev().take_while(|x| **x == b'=').count();
        if pad > 2 || (pad > 0 && i != last) {
            return Err(());
        }
        let mut n = 0u32;
        for (j, ch) in c.iter().enumerate() {
            let v = if j >= 4 - pad { 0 } else { val(*ch).ok_or(())? };
            n = n << 6 | v;
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tl_wallet_service::amount::Amount;
    use tl_wallet_service::gate::{Gate, GateConfig, MethodAllowlist, SessionToken};
    use tl_wallet_service::mem::{MemConnector, MemKeys, MemRelayer, MemRpc, MemStore};
    use tl_wallet_service::service::{HttpRequest, HttpResponse, WalletService};

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const ORIGIN: &str = "http://tauri.localhost";

    fn txid(n: u8) -> String {
        format!("{n:02x}").repeat(32)
    }

    fn utxo(n: u8, vout: u32, sat: u64, redeem: Option<&str>) -> Utxo {
        Utxo {
            txid: txid(n),
            vout,
            amount: Amount::from_sat(sat).unwrap(),
            confirmations: 3,
            script_pub_key: format!("0014{}", "11".repeat(20)),
            redeem_script: redeem.map(str::to_string),
            pubkey: None,
        }
    }

    /// A signer wired to a scripted node, plus the node's call log.
    fn signer_with_node() -> (NodeWalletSigner, MemRpc, Shared) {
        let node = MemRpc::default();
        let shared: Shared = Rc::new(RefCell::new(Box::new(node.clone())));
        let slot = NodeSlot::default();
        slot.set(&shared);
        (NodeWalletSigner::new(slot), node, shared)
    }

    #[test]
    fn encodings_round_trip_and_reject_garbage() {
        for (raw, b64) in [
            (&b""[..], ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (&[0xfb, 0xff, 0xfe][..], "+//+"),
        ] {
            assert_eq!(b64_encode(raw), b64);
            if !raw.is_empty() {
                assert_eq!(b64_decode(b64).unwrap(), raw);
            }
        }
        // the PSBT magic, as hex and as the node prints it
        assert_eq!(b64_encode(&hex_to_bytes("70736274ff").unwrap()), "cHNidP8=");
        assert_eq!(bytes_to_hex(&b64_decode("cHNidP8=").unwrap()), "70736274ff");
        for bad in ["", "Zg=", "Zg", "Z===", "Zg==Zg==", "Zm9v!A==", "Zm 9v"] {
            assert!(b64_decode(bad).is_err(), "{bad:?}");
        }
        for bad in ["", "0", "zz", "0g"] {
            assert!(hex_to_bytes(bad).is_err(), "{bad:?}");
        }
        assert_eq!(hex_to_bytes("00fF").unwrap(), vec![0, 255]);
    }

    #[test]
    fn sign_tx_asks_the_node_wallet_with_prevtxs_and_maps_the_result() {
        let (mut s, node, _keep) = signer_with_node();
        node.script(
            "signrawtransactionwithwallet",
            json!({"hex": "0200signed", "complete": true}),
        );
        let ws = "5221aa52ae";
        let inputs = [utxo(1, 0, 1_000_000, None), utxo(2, 3, 250_000, Some(ws))];
        let r = s.sign_tx("LTCTEST", "0200raw", "", &inputs).unwrap();
        assert_eq!(
            r,
            json!({"isValid": true, "signedHex": "0200signed", "isFinished": true})
        );
        let calls = node.0.borrow().calls.clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "signrawtransactionwithwallet");
        let spk = format!("0014{}", "11".repeat(20));
        assert_eq!(
            calls[0].1,
            vec![
                json!("0200raw"),
                json!([
                    {"txid": txid(1), "vout": 0, "scriptPubKey": spk, "amount": 0.01},
                    {"txid": txid(2), "vout": 3, "scriptPubKey": spk, "amount": 0.0025, "witnessScript": ws},
                ]),
            ]
        );
    }

    #[test]
    fn sign_tx_reports_a_partial_signature_as_invalid_and_skips_empty_scripts() {
        let (mut s, node, _keep) = signer_with_node();
        node.script(
            "signrawtransactionwithwallet",
            json!({"hex": "0200half", "complete": false, "errors": [{"txid": "x"}]}),
        );
        let mut u = utxo(1, 0, 5_000, None);
        u.script_pub_key.clear();
        let r = s.sign_tx("LTC", "0200raw", "", &[u]).unwrap();
        assert_eq!(r["isValid"], json!(false));
        assert_eq!(r["signedHex"], json!("0200half"));
        assert_eq!(node.0.borrow().calls[0].1[1], json!([]));
    }

    #[test]
    fn sign_tx_surfaces_node_errors_and_malformed_inputs() {
        let (mut s, node, _keep) = signer_with_node();
        // not scripted: the mock answers with an error string
        assert!(s.sign_tx("LTC", "00", "", &[]).is_err());
        node.script("signrawtransactionwithwallet", json!({"complete": true}));
        assert!(s
            .sign_tx("LTC", "00", "", &[])
            .unwrap_err()
            .contains("no hex"));
        let mut u = utxo(1, 0, 1, None);
        u.script_pub_key = "zz".into();
        let n = node.total_calls();
        assert_eq!(
            s.sign_tx("LTC", "00", "", &[u]).unwrap_err(),
            "input.scriptPubKey malformed"
        );
        let mut u = utxo(1, 0, 1, Some("xyz"));
        u.script_pub_key = "00".into();
        assert_eq!(
            s.sign_tx("LTC", "00", "", &[u]).unwrap_err(),
            "input.redeemScript malformed"
        );
        assert_eq!(node.total_calls(), n);
    }

    #[test]
    fn sign_psbt_converts_hex_to_base64_and_back_and_finalizes_when_complete() {
        let (mut s, node, _keep) = signer_with_node();
        node.script(
            "walletprocesspsbt",
            json!({"psbt": "cHNidP8BAA==", "complete": true}),
        );
        node.script(
            "finalizepsbt",
            json!({"hex": "0200final", "complete": true}),
        );
        let r = s.sign_psbt("LTCTEST", "", "70736274ff0100").unwrap();
        assert_eq!(
            r,
            json!({"psbtHex": "70736274ff0100", "isValid": true, "isFinished": true, "finalHex": "0200final"})
        );
        let calls = node.0.borrow().calls.clone();
        assert_eq!(
            calls,
            vec![
                (
                    "walletprocesspsbt".to_string(),
                    vec![
                        json!("cHNidP8BAA=="),
                        json!(true),
                        json!("ALL"),
                        json!(true)
                    ]
                ),
                (
                    "finalizepsbt".to_string(),
                    vec![json!("cHNidP8BAA=="), json!(true)]
                ),
            ]
        );
    }

    #[test]
    fn sign_psbt_partial_keeps_the_psbt_and_never_finalizes() {
        let (mut s, node, _keep) = signer_with_node();
        // the node added a signature (the PSBT changed) but 2-of-2 is not complete
        node.script(
            "walletprocesspsbt",
            json!({"psbt": "cHNidP8BAQ==", "complete": false}),
        );
        let r = s.sign_psbt("LTC", "", "70736274ff0100").unwrap();
        assert_eq!(
            r,
            json!({"psbtHex": "70736274ff0101", "isValid": true, "isFinished": false})
        );
        assert_eq!(node.calls_of("finalizepsbt"), 0);
        // nothing signed: the PSBT comes back unchanged
        node.script(
            "walletprocesspsbt",
            json!({"psbt": "cHNidP8BAA==", "complete": false}),
        );
        let r = s.sign_psbt("LTC", "", "70736274ff0100").unwrap();
        assert_eq!(r["isValid"], json!(false));
        assert_eq!(r["isFinished"], json!(false));
        assert!(r.get("finalHex").is_none());
    }

    #[test]
    fn sign_psbt_complete_but_unfinalizable_is_not_finished() {
        let (mut s, node, _keep) = signer_with_node();
        node.script(
            "walletprocesspsbt",
            json!({"psbt": "cHNidP8BAA==", "complete": true}),
        );
        node.script(
            "finalizepsbt",
            json!({"psbt": "cHNidP8BAA==", "complete": false}),
        );
        let r = s.sign_psbt("LTC", "", "70736274ff0100").unwrap();
        assert_eq!(r["isFinished"], json!(false));
        assert!(r.get("finalHex").is_none());
    }

    #[test]
    fn sign_psbt_rejects_malformed_hex_and_malformed_node_replies() {
        let (mut s, node, _keep) = signer_with_node();
        for bad in ["", "7", "zz", &"00".repeat(MAX_PSBT_HEX_CHARS / 2 + 1)] {
            assert!(s.sign_psbt("LTC", "", bad).is_err());
        }
        assert_eq!(node.total_calls(), 0);
        node.script("walletprocesspsbt", json!({"complete": true}));
        assert!(s.sign_psbt("LTC", "", "00").is_err());
        node.script(
            "walletprocesspsbt",
            json!({"psbt": "***", "complete": true}),
        );
        assert!(s.sign_psbt("LTC", "", "00").is_err());
    }

    #[test]
    fn non_empty_wif_is_refused_before_any_rpc() {
        let (mut s, node, _keep) = signer_with_node();
        for wif in ["cV7synthetic", " ", "0"] {
            assert_eq!(s.sign_tx("LTC", "00", wif, &[]).unwrap_err(), WIF_REFUSED);
            assert_eq!(s.sign_psbt("LTC", wif, "00").unwrap_err(), WIF_REFUSED);
        }
        assert_eq!(node.total_calls(), 0);
    }

    #[test]
    fn signer_without_a_node_reports_no_client() {
        let mut s = NodeWalletSigner::new(NodeSlot::default());
        assert_eq!(s.sign_tx("LTC", "00", "", &[]).unwrap_err(), NO_NODE);
        assert_eq!(s.sign_psbt("LTC", "", "00").unwrap_err(), NO_NODE);
    }

    #[test]
    fn signer_handle_expires_when_the_service_drops_the_connection() {
        let (mut s, node, shared) = signer_with_node();
        node.script(
            "signrawtransactionwithwallet",
            json!({"hex": "00", "complete": true}),
        );
        assert!(s.sign_tx("LTC", "00", "", &[]).is_ok());
        drop(shared);
        assert_eq!(s.sign_tx("LTC", "00", "", &[]).unwrap_err(), NO_NODE);
    }

    // ---- end to end through WalletService::handle

    struct Fx {
        svc: WalletService,
        node: MemRpc,
        slot: NodeSlot,
    }

    fn fixture() -> Fx {
        let conn = MemConnector::default();
        let node = conn.node.clone();
        let store = MemStore::default();
        store.0.borrow_mut().files.insert(
            "/ltc/litecoin.conf".into(),
            "rpcuser=u\nrpcpassword=p\nrpcport=9332\n".into(),
        );
        let slot = NodeSlot::default();
        let gate = Gate::new(GateConfig {
            port: 1,
            token: SessionToken::from_hex(TOKEN).unwrap(),
            allowed_origins: vec![ORIGIN.into()],
            methods: MethodAllowlist::wallet_default(),
        });
        let svc = WalletService::new(
            gate,
            Box::new(MemKeys),
            Box::new(NodeWalletSigner::new(slot.clone())),
            Box::new(store.clone()),
            Box::new(SharedConnector::new(conn, slot.clone())),
            Box::new(MemRelayer::default()),
            vec![],
            "/ltc".into(),
        );
        Fx { svc, node, slot }
    }

    fn call(f: &mut Fx, path: &str, body: Value) -> HttpResponse {
        let mut r = HttpRequest::post(path, TOKEN, body);
        r.host = Some("localhost:1".into());
        r.origin = Some(ORIGIN.into());
        f.svc.handle(&r)
    }

    fn start_node(f: &mut Fx) {
        let r = call(
            f,
            "/api/start-wallet-node",
            json!({"network": "LTCTEST", "path": ""}),
        );
        assert_eq!(r.status, 200, "{:?}", r.body);
    }

    fn le64(n: u64) -> String {
        bytes_to_hex(&n.to_le_bytes())
    }

    /// One input spending `txid(1):0`, one 22-byte output paying `out_sat`.
    fn raw_tx(out_sat: u64) -> String {
        let script = format!("0014{}", "07".repeat(20));
        let input = format!("01{}0000000000ffffffff", txid(1));
        let output = format!("01{}{:02x}{script}", le64(out_sat), script.len() / 2);
        format!("02000000{input}{output}00000000")
    }

    /// A PSBT of `raw_tx(out_sat)` whose input carries a witness UTXO worth `in_sat`.
    fn psbt_hex(out_sat: u64, in_sat: u64) -> String {
        let tx = raw_tx(out_sat);
        let script = format!("0014{}", "11".repeat(20));
        let wu = format!("{}{:02x}{script}", le64(in_sat), script.len() / 2);
        format!(
            "70736274ff0100{:02x}{tx}000101{:02x}{wu}0000",
            tx.len() / 2,
            wu.len() / 2
        )
    }

    fn signed_input() -> Value {
        json!([{"txid": txid(1), "vout": 0, "amount": 0.01, "confirmations": 3,
                "scriptPubKey": format!("0014{}", "11".repeat(20))}])
    }

    #[test]
    fn end_to_end_sign_tx_with_empty_wif_runs_the_guard_then_the_node_wallet() {
        let mut f = fixture();
        start_node(&mut f);
        f.node.script("gettxout", json!({"value": 0.01}));
        f.node.script(
            "signrawtransactionwithwallet",
            json!({"hex": "0200signed", "complete": true}),
        );
        let r = call(
            &mut f,
            "/api/sign-tx",
            json!({"rawtx": raw_tx(940_000), "wif": "", "network": "LTCTEST", "inputs": signed_input()}),
        );
        assert_eq!(r.status, 200, "{:?}", r.body);
        assert_eq!(
            r.body,
            json!({"data": {"isValid": true, "signedHex": "0200signed", "isFinished": true}})
        );
        // guard (gettxout) ran before the signer, on the same node the service connected to
        let order: Vec<String> = f
            .node
            .0
            .borrow()
            .calls
            .iter()
            .map(|c| c.0.clone())
            .collect();
        assert_eq!(order, ["gettxout", "signrawtransactionwithwallet"]);
    }

    #[test]
    fn end_to_end_guard_failures_never_reach_the_signer() {
        let mut f = fixture();
        start_node(&mut f);
        f.node.script("gettxout", json!({"value": 0.01}));
        f.node.script(
            "signrawtransactionwithwallet",
            json!({"hex": "00", "complete": true}),
        );
        let body = |out: u64, inputs: Value| json!({"rawtx": raw_tx(out), "wif": "", "network": "LTCTEST", "inputs": inputs});
        // fee above the one-input bound
        let r = call(&mut f, "/api/sign-tx", body(939_999, signed_input()));
        assert_eq!(r.status, 500);
        assert!(r.body["error"].as_str().unwrap().starts_with("sign guard"));
        // understated input amount
        let lie = json!([{"txid": txid(1), "vout": 0, "amount": 0.0001, "scriptPubKey": "0014aa"}]);
        assert_eq!(call(&mut f, "/api/sign-tx", body(50, lie)).status, 500);
        // spends an outpoint that is not among the inputs
        assert_eq!(
            call(&mut f, "/api/sign-tx", body(940_000, json!([]))).status,
            500
        );
        assert_eq!(f.node.calls_of("signrawtransactionwithwallet"), 0);
    }

    #[test]
    fn end_to_end_non_empty_wif_is_refused_after_the_guard_and_before_signing() {
        let mut f = fixture();
        start_node(&mut f);
        f.node.script("gettxout", json!({"value": 0.01}));
        let r = call(
            &mut f,
            "/api/sign-tx",
            json!({"rawtx": raw_tx(940_000), "wif": "cV7synthetic", "network": "LTCTEST", "inputs": signed_input()}),
        );
        assert_eq!(r.status, 500);
        assert_eq!(r.body["error"], WIF_REFUSED);
        assert_eq!(f.node.calls_of("signrawtransactionwithwallet"), 0);
        let r = call(
            &mut f,
            "/api/sign-psbt",
            json!({"psbtHex": psbt_hex(940_000, 1_000_000), "wif": "cV7synthetic", "network": "LTCTEST"}),
        );
        assert_eq!(r.status, 500);
        assert_eq!(r.body["error"], WIF_REFUSED);
        assert_eq!(f.node.calls_of("walletprocesspsbt"), 0);
    }

    #[test]
    fn end_to_end_sign_psbt_guard_then_node_wallet() {
        let mut f = fixture();
        start_node(&mut f);
        f.node.script("gettxout", json!({"value": 0.01}));
        f.node.script(
            "walletprocesspsbt",
            json!({"psbt": "cHNidP8BAA==", "complete": true}),
        );
        f.node.script(
            "finalizepsbt",
            json!({"hex": "0200final", "complete": true}),
        );
        let ok = psbt_hex(940_000, 1_000_000);
        let r = call(
            &mut f,
            "/api/sign-psbt",
            json!({"psbtHex": ok, "wif": "", "network": "LTCTEST"}),
        );
        assert_eq!(r.status, 200, "{:?}", r.body);
        assert_eq!(
            r.body,
            json!({"data": {"psbtHex": "70736274ff0100", "isValid": true, "isFinished": true, "finalHex": "0200final"}})
        );
        let first_psbt = f.node.0.borrow().calls[1].1[0].clone();
        assert_eq!(first_psbt, json!(b64_encode(&hex_to_bytes(&ok).unwrap())));
        // fee above the bound: guard refuses, no further node wallet call
        let before = f.node.total_calls();
        let r = call(
            &mut f,
            "/api/sign-psbt",
            json!({"psbtHex": psbt_hex(1, 1_000_000), "wif": "", "network": "LTCTEST"}),
        );
        assert_eq!(r.status, 500);
        assert!(r.body["error"].as_str().unwrap().starts_with("sign guard"));
        assert_eq!(f.node.calls_of("walletprocesspsbt"), 1);
        assert_eq!(f.node.total_calls(), before + 1); // only the guard's gettxout
                                                      // witness amount that differs from the chain: refused
        let r = call(
            &mut f,
            "/api/sign-psbt",
            json!({"psbtHex": psbt_hex(940_000, 1_100_000), "wif": "", "network": "LTCTEST"}),
        );
        assert_eq!(r.status, 500);
        assert_eq!(f.node.calls_of("walletprocesspsbt"), 1);
    }

    #[test]
    fn stopping_the_node_expires_the_signer_handle() {
        let mut f = fixture();
        start_node(&mut f);
        f.node.script("stop", json!("Litecoin stopping"));
        f.node.script(
            "signrawtransactionwithwallet",
            json!({"hex": "00", "complete": true}),
        );
        assert!(f.slot.call("signrawtransactionwithwallet", &[]).is_ok());
        assert_eq!(call(&mut f, "/api/stop-wallet-node", json!({})).status, 200);
        assert_eq!(
            f.slot
                .call("signrawtransactionwithwallet", &[])
                .unwrap_err(),
            NO_NODE
        );
        // a second start-wallet-node reconnects the signer to the new client
        start_node(&mut f);
        assert!(f.slot.call("signrawtransactionwithwallet", &[]).is_ok());
    }
}
