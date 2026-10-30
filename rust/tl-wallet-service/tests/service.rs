mod common;
use common::*;
use serde_json::{json, Value};
use tl_wallet_service::gate::*;
use tl_wallet_service::mem::*;
use tl_wallet_service::service::*;

const TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const FROM: &str = "MfromAddress1234";
const TO: &str = "MtoAddress1234567";

struct Fx {
    svc: WalletService,
    node: MemRpc,
    relayer: MemRpc,
    store: MemStore,
    signer: MemSigner,
    connector: MemConnector,
}

fn fixture() -> Fx {
    let gate = Gate::new(GateConfig {
        port: 1986,
        token: SessionToken::from_hex(TOKEN).unwrap(),
        allowed_origins: vec!["file://".into()],
        methods: MethodAllowlist::wallet_default(),
    });
    let relayer = MemRelayer::default();
    let store = MemStore::default();
    store.0.borrow_mut().dirs.insert("/home/u/.litecoin".into());
    let signer = MemSigner::default();
    let connector = MemConnector::default();
    let svc = WalletService::new(
        gate,
        Box::new(MemKeys),
        Box::new(signer.clone()),
        Box::new(store.clone()),
        Box::new(connector.clone()),
        Box::new(relayer.clone()),
        vec!["relayer.example".into()],
        "/home/u/.litecoin".into(),
    );
    Fx {
        svc,
        node: connector.node.clone(),
        relayer: relayer.0.clone(),
        store,
        signer,
        connector,
    }
}

fn call(f: &mut Fx, path: &str, body: Value) -> HttpResponse {
    let mut r = HttpRequest::post(path, TOKEN, body);
    r.host = Some("localhost:1986".into());
    r.origin = Some("file://".into());
    f.svc.handle(&r)
}

fn start_node(f: &mut Fx) {
    f.store.0.borrow_mut().files.insert(
        "/home/u/.litecoin/litecoin.conf".into(),
        "rpcuser=u\nrpcpassword=p=ss\nrpcport=19332\n".into(),
    );
    let r = call(
        f,
        "/api/start-wallet-node",
        json!({"network":"LTCTEST","path":"/home/u/.litecoin"}),
    );
    assert_eq!(r.status, 200, "{:?}", r.body);
    let r = call(
        f,
        "/api/set-api-url",
        json!({"apiUrl":"https://relayer.example"}),
    );
    assert_eq!(r.status, 200);
}

// ---------------- gate in front of every route ----------------

const ROUTES: [&str; 12] = [
    "/keys/new-wallet",
    "/keys/get-address",
    "/keys/get-address-file",
    "/api/rpc-call",
    "/api/start-wallet-node",
    "/api/stop-wallet-node",
    "/api/new-config",
    "/api/build-tx",
    "/api/build-ltcit-tx",
    "/api/sign-tx",
    "/api/sign-psbt",
    "/api/set-api-url",
];

#[test]
fn repaired_every_route_requires_the_session_token() {
    let mut f = fixture();
    start_node(&mut f);
    f.node.script("dumpprivkey", json!("L1secret"));
    let before = f.node.total_calls();
    for p in ROUTES {
        // no token
        let mut r = HttpRequest::post(p, TOKEN, json!({}));
        r.token = None;
        r.host = Some("localhost:1986".into());
        assert_eq!(f.svc.handle(&r).status, 401, "{p}");
        // wrong token
        let mut r = HttpRequest::post(p, &"11".repeat(32), json!({}));
        r.host = Some("localhost:1986".into());
        assert_eq!(f.svc.handle(&r).status, 401, "{p}");
        // foreign origin
        let mut r = HttpRequest::post(p, TOKEN, json!({}));
        r.host = Some("localhost:1986".into());
        r.origin = Some("https://evil.example".into());
        let resp = f.svc.handle(&r);
        assert_eq!(resp.status, 403, "{p}");
        assert_eq!(resp.allow_origin, None);
        // rebinding host
        let mut r = HttpRequest::post(p, TOKEN, json!({}));
        r.host = Some("evil.example:1986".into());
        assert_eq!(f.svc.handle(&r).status, 403, "{p}");
        // remote peer
        let mut r = HttpRequest::post(p, TOKEN, json!({}));
        r.host = Some("localhost:1986".into());
        r.peer_is_loopback = false;
        assert_eq!(f.svc.handle(&r).status, 403, "{p}");
    }
    // nothing reached the node
    assert_eq!(f.node.total_calls(), before);
}

#[test]
fn repaired_rpc_proxy_blocks_unlisted_methods_and_still_serves_listed_ones() {
    let mut f = fixture();
    start_node(&mut f);
    f.node.script("dumpprivkey", json!("L1secret"));
    f.node.script("getblockchaininfo", json!({"blocks": 5}));
    let r = call(
        &mut f,
        "/api/rpc-call",
        json!({"method":"dumpprivkey","params":["addr"]}),
    );
    assert_eq!(r.status, 403);
    assert_eq!(f.node.calls_of("dumpprivkey"), 0);
    let r = call(
        &mut f,
        "/api/rpc-call",
        json!({"method":"getblockchaininfo"}),
    );
    assert_eq!(r.status, 200);
    assert_eq!(r.body, json!({"data": {"blocks": 5}}));
    assert_eq!(f.node.calls_of("getblockchaininfo"), 1);
    // oversize params, wrong shapes
    let many: Vec<Value> = (0..MAX_RPC_PARAMS + 1).map(|i| json!(i)).collect();
    assert_eq!(
        call(
            &mut f,
            "/api/rpc-call",
            json!({"method":"listunspent","params":many})
        )
        .status,
        403
    );
    assert_eq!(
        call(
            &mut f,
            "/api/rpc-call",
            json!({"method":"listunspent","params":"x"})
        )
        .status,
        500
    );
    assert_eq!(
        call(&mut f, "/api/rpc-call", json!({"params":[]})).status,
        500
    );
}

#[test]
fn rpc_before_node_start_is_an_error() {
    let mut f = fixture();
    let r = call(
        &mut f,
        "/api/rpc-call",
        json!({"method":"getblockchaininfo"}),
    );
    assert_eq!(r.status, 500);
    assert_eq!(r.body, json!({"error":"No RPC Client initialized"}));
}

#[test]
fn preflight_and_cors_headers() {
    let mut f = fixture();
    let mut r = HttpRequest::post("/api/rpc-call", TOKEN, json!({}));
    r.method = "OPTIONS".into();
    r.token = None;
    r.host = Some("localhost:1986".into());
    r.origin = Some("file://".into());
    let resp = f.svc.handle(&r);
    assert_eq!(
        (resp.status, resp.allow_origin.as_deref()),
        (204, Some("file://"))
    );
    r.origin = Some("https://evil.example".into());
    let resp = f.svc.handle(&r);
    assert_eq!((resp.status, resp.allow_origin), (403, None));
    // a good POST echoes only the allowlisted origin, never "*"
    let resp = call(&mut f, "/keys/new-wallet", json!({"network":"LTC"}));
    assert_eq!(resp.allow_origin.as_deref(), Some("file://"));
    // GET is not a route method
    let mut g = HttpRequest::post("/keys/new-wallet", TOKEN, json!({}));
    g.method = "GET".into();
    g.host = Some("localhost:1986".into());
    assert_eq!(f.svc.handle(&g).status, 405);
    // body bound
    let mut big = HttpRequest::post("/keys/new-wallet", TOKEN, json!({}));
    big.host = Some("localhost:1986".into());
    big.body_len = MAX_BODY_BYTES + 1;
    assert_eq!(f.svc.handle(&big).status, 413);
    assert_eq!(call(&mut f, "/nope", json!({})).status, 404);
}

// ---------------- key routes ----------------

#[test]
fn key_routes_validate_inputs() {
    let mut f = fixture();
    let ok = call(&mut f, "/keys/new-wallet", json!({"network":"LTC"}));
    assert_eq!(ok.status, 200);
    assert!(ok.body["mnemonic"].as_str().unwrap().split(' ').count() == 12);
    assert_eq!(
        call(&mut f, "/keys/new-wallet", json!({"network":"DOGE"})).status,
        500
    );
    let m = ok.body["mnemonic"].as_str().unwrap().to_string();
    let good = call(
        &mut f,
        "/keys/get-address",
        json!({"network":"LTC","mnemonic":m,"derivatePath":"m/49'/2'/0'/0/0"}),
    );
    assert_eq!(good.status, 200);
    assert_eq!(good.body["address"], "synthetic-m/49'/2'/0'/0/0");
    for bad in [
        "",
        "49/2/0",
        "m/../x",
        "m/49'/x",
        "m//1",
        "m/4294967296",
        &format!("m{}", "/1".repeat(11)),
    ] {
        let r = call(
            &mut f,
            "/keys/get-address",
            json!({"network":"LTC","mnemonic":m,"derivatePath":bad}),
        );
        assert_eq!(r.status, 500, "{bad}");
    }
    let r = call(
        &mut f,
        "/keys/get-address",
        json!({"network":"LTC","mnemonic":"too short","derivatePath":"m/0"}),
    );
    assert_eq!(r.status, 500);
    let file = call(
        &mut f,
        "/keys/get-address-file",
        json!({"network":"LTC","mnemonic":m,"walletObjRaw":{"spot":["m/0","m/1"],"futures":["m/2"]}}),
    );
    assert_eq!(file.status, 200);
    assert_eq!(file.body["spot"].as_array().unwrap().len(), 2);
    let many: Vec<String> = (0..300).map(|i| format!("m/{i}")).collect();
    let r = call(
        &mut f,
        "/keys/get-address-file",
        json!({"network":"LTC","mnemonic":m,"walletObjRaw":{"a":many}}),
    );
    assert_eq!(r.status, 500);
}

// ---------------- node + config ----------------

#[test]
fn new_config_writes_the_legacy_layout_once() {
    let mut f = fixture();
    let r = call(
        &mut f,
        "/api/new-config",
        json!({"username":"user","password":"s3cret","port":19332,"path":"/home/u/.litecoin"}),
    );
    assert_eq!(r.status, 200);
    assert_eq!(
        f.store.0.borrow().files["/home/u/.litecoin/litecoin.conf"],
        "rpcuser=user\nrpcpassword=s3cret\nrpcport=19332\ntxindex=1"
    );
    let again = call(
        &mut f,
        "/api/new-config",
        json!({"username":"user","password":"s3cret","port":19332}),
    );
    assert_eq!(again.status, 500);
    assert!(again.body["error"]
        .as_str()
        .unwrap()
        .contains("Already exist"));
    let missing = call(
        &mut f,
        "/api/new-config",
        json!({"username":"u","password":"p","port":1,"path":"/nowhere"}),
    );
    assert!(missing.body["error"]
        .as_str()
        .unwrap()
        .contains("Dont exist"));
}

#[test]
fn repaired_config_injection_is_rejected() {
    let mut f = fixture();
    for (u, p) in [
        ("user", "pass\nblocknotify=/bin/sh -c evil"),
        ("user\nrpcallowip=0.0.0.0/0", "pass"),
        ("us er", "pass"),
        ("user", "pa#ss"),
        ("user", ""),
        ("", "pass"),
        ("us=er", "pass"),
    ] {
        let r = call(
            &mut f,
            "/api/new-config",
            json!({"username":u,"password":p,"port":8332}),
        );
        assert_eq!(r.status, 500, "{u:?}/{p:?}");
    }
    assert!(f.store.0.borrow().files.is_empty());
    for port in [
        json!(0),
        json!(70000),
        json!(-1),
        json!("8332"),
        json!(null),
    ] {
        let r = call(
            &mut f,
            "/api/new-config",
            json!({"username":"u","password":"p","port":port}),
        );
        assert_eq!(r.status, 500);
    }
}

#[test]
fn start_node_reads_conf_keeping_equals_signs_in_values() {
    let mut f = fixture();
    start_node(&mut f);
    assert!(f.svc.node_connected());
    let ep = f.connector.connected.borrow()[0].clone();
    assert_eq!(ep.password, "p=ss"); // legacy split('=') truncated this to "p"
    assert_eq!(ep.port, 19332);
    // stop calls the node's `stop` and drops the client
    f.node.script("stop", json!("Litecoin server stopping"));
    let r = call(&mut f, "/api/stop-wallet-node", json!({}));
    assert_eq!(r.status, 200);
    assert_eq!(f.node.calls_of("stop"), 1);
    assert!(!f.svc.node_connected());
}

#[test]
fn start_node_error_paths() {
    let mut f = fixture();
    let r = call(&mut f, "/api/start-wallet-node", json!({"network":"LTC"}));
    assert!(r.body["error"].as_str().unwrap().contains("doesn't exist"));
    let r = call(&mut f, "/api/start-wallet-node", json!({"network":"BTC"}));
    assert_eq!(r.status, 500);
    let r = call(
        &mut f,
        "/api/start-wallet-node",
        json!({"network":"LTC","path":"/x\"; rm -rf / #"}),
    );
    assert_eq!(r.status, 500);
    f.store.0.borrow_mut().files.insert(
        "/home/u/.litecoin/litecoin.conf".into(),
        "rpcuser=u\n".into(),
    );
    let r = call(&mut f, "/api/start-wallet-node", json!({"network":"LTC"}));
    assert!(r.body["error"]
        .as_str()
        .unwrap()
        .starts_with("Incorrect Config File"));
    f.store.0.borrow_mut().files.insert(
        "/home/u/.litecoin/litecoin.conf".into(),
        "rpcuser=u\nrpcpassword=p\nrpchost=10.0.0.5\n".into(),
    );
    // legacy would have sent the RPC password to any rpchost
    f.store
        .0
        .borrow_mut()
        .files
        .remove("/home/u/.litecoin/litecoin.conf");
    f.store.0.borrow_mut().files.insert(
        "/home/u/.litecoin/litecoin.conf".into(),
        "rpcuser=u\nrpcpassword=p\nrpchost=10.0.0.5\n".into(),
    );
    let r = call(&mut f, "/api/start-wallet-node", json!({"network":"LTC"}));
    assert!(r.body["error"]
        .as_str()
        .unwrap()
        .starts_with("Incorrect Config File"));
    assert!(!f.svc.node_connected());
}

#[test]
fn repaired_set_api_url_is_validated() {
    let mut f = fixture();
    assert_eq!(
        call(
            &mut f,
            "/api/set-api-url",
            json!({"apiUrl":"https://relayer.example/api"})
        )
        .status,
        200
    );
    assert_eq!(f.svc.relayer_url(), Some("https://relayer.example/api"));
    for bad in [
        "https://evil.example",
        "http://relayer.example",
        "ftp://relayer.example",
        "https://relayer.example@evil.example",
        "https://relayer.example/?x=1",
        "relayer.example",
        "https://",
        "https://relayer.example\n/x",
    ] {
        let r = call(&mut f, "/api/set-api-url", json!({"apiUrl":bad}));
        assert_eq!(r.status, 500, "{bad:?}");
    }
    assert_eq!(f.svc.relayer_url(), Some("https://relayer.example/api"));
    assert_eq!(
        call(&mut f, "/api/set-api-url", json!({"apiUrl":null})).status,
        200
    );
    assert_eq!(f.svc.relayer_url(), None);
}

// ---------------- build-tx ----------------

fn script_chain(f: &mut Fx, utxos: Value) {
    for rpc in [&f.node, &f.relayer] {
        rpc.script("validateaddress", json!({"isvalid": true}));
        rpc.script("listunspent", utxos.clone());
        rpc.script("tl_createrawtx_reference", json!("0200"));
        rpc.script(
            "decoderawtransaction",
            json!({"vout":[{"value": 0.000036}]}),
        );
        rpc.script("createrawtransaction", json!("0100raw"));
        rpc.script("tl_createrawtx_opreturn", json!("0100rawOP"));
    }
}

fn wallet_utxos() -> Value {
    json!([
        {"txid": txid(1), "vout": 0, "amount": 0.5, "confirmations": 5, "scriptPubKey": "0014aa"},
        {"txid": txid(2), "vout": 1, "amount": 0.1, "confirmations": 1, "scriptPubKey": "0014aa"}
    ])
}

#[test]
fn build_tx_payment_without_payload() {
    let mut f = fixture();
    start_node(&mut f);
    f.svc.handle(&{
        let mut r = HttpRequest::post(
            "/api/set-api-url",
            TOKEN,
            json!({"apiUrl":"https://relayer.example"}),
        );
        r.host = Some("localhost:1986".into());
        r
    });
    script_chain(&mut f, wallet_utxos());
    let r = call(
        &mut f,
        "/api/build-tx",
        json!({
            "fromKeyPair": {"address": FROM, "pubkey": G},
            "toKeyPair": {"address": TO},
            "amount": 0.1,
            "network": "LTCTEST",
        }),
    );
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(r.body["data"]["rawtx"], "0100raw");
    assert_eq!(r.body["data"]["inputs"].as_array().unwrap().len(), 1);
    // outputs: to = 0.1 - 0.0006, change = 0.5 - 0.1
    let (_, params) = f
        .node
        .0
        .borrow()
        .calls
        .iter()
        .find(|(m, _)| m == "createrawtransaction")
        .cloned()
        .unwrap();
    assert_eq!(params[1][TO].as_f64().unwrap(), 0.0994);
    assert_eq!(params[1][FROM].as_f64().unwrap(), 0.4);
    // listunspent always went through the relayer API, never the local node
    assert_eq!(f.node.calls_of("listunspent"), 0);
    assert_eq!(f.relayer.calls_of("listunspent"), 1);
}

#[test]
fn build_tx_with_payload_adds_opreturn_and_psbt_failure_is_reported() {
    let mut f = fixture();
    start_node(&mut f);
    f.svc.handle(&{
        let mut r = HttpRequest::post(
            "/api/set-api-url",
            TOKEN,
            json!({"apiUrl":"https://relayer.example"}),
        );
        r.host = Some("localhost:1986".into());
        r
    });
    script_chain(&mut f, wallet_utxos());
    let r = call(
        &mut f,
        "/api/build-tx",
        json!({
            "fromKeyPair": {"address": FROM},
            "toKeyPair": {"address": TO},
            "payload": "746c",
            "network": "LTCTEST",
        }),
    );
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(r.body["data"]["rawtx"], "0100rawOP");
    assert_eq!(f.node.calls_of("tl_createrawtx_opreturn"), 1);
    // addPsbt on a bogus rawtx surfaces a buildPsbt error instead of garbage
    let r = call(
        &mut f,
        "/api/build-tx",
        json!({
            "fromKeyPair": {"address": FROM, "pubkey": G},
            "toKeyPair": {"address": TO},
            "payload": "746c",
            "addPsbt": true,
            "network": "LTCTEST",
        }),
    );
    assert_eq!(r.status, 500);
    assert!(r.body["error"].as_str().unwrap().starts_with("buildPsbt"));
}

#[test]
fn build_tx_rejects_bad_input() {
    let mut f = fixture();
    start_node(&mut f);
    script_chain(&mut f, wallet_utxos());
    let base = json!({"fromKeyPair": {"address": FROM}, "toKeyPair": {"address": TO}, "network": "LTCTEST"});
    let with = |k: &str, v: Value| {
        let mut b = base.clone();
        b[k] = v;
        b
    };
    for body in [
        with("payload", json!("zz")),
        with("amount", json!("0.1")),
        with("amount", json!(-1)),
        with("network", json!("XYZ")),
        with("inputs", json!([{"txid":"12","vout":0,"amount":1}])),
        with("fromKeyPair", json!({"address":"bad address!"})),
    ] {
        assert_eq!(
            call(&mut f, "/api/build-tx", body.clone()).status,
            500,
            "{body}"
        );
    }
    // minimum amount without payload
    let r = call(&mut f, "/api/build-tx", with("amount", json!(0.00001)));
    assert!(r.body["error"]
        .as_str()
        .unwrap()
        .starts_with("Minimum amount is"));
    // relayer url not set while a call needs it (isApiMode)
    let mut f2 = fixture();
    let r = call(&mut f2, "/api/build-tx", with("isApiMode", json!(true)));
    assert_eq!(r.body["error"], "Relayer API url not found");
}

#[test]
fn build_ltcit_tx_places_buyer_change_and_seller_amount() {
    let mut f = fixture();
    start_node(&mut f);
    f.svc.handle(&{
        let mut r = HttpRequest::post(
            "/api/set-api-url",
            TOKEN,
            json!({"apiUrl":"https://relayer.example"}),
        );
        r.host = Some("localhost:1986".into());
        r
    });
    script_chain(&mut f, wallet_utxos());
    let commit = json!({"txid": txid(9), "vout": 0, "amount": 0.000036, "confirmations": 1, "scriptPubKey": "a914cc", "redeemScript": "52ae"});
    let r = call(
        &mut f,
        "/api/build-ltcit-tx",
        json!({
            "buyerKeyPair": {"address": FROM, "pubkey": G},
            "sellerKeyPair": {"address": TO},
            "payload": "746c",
            "amount": 0,
            "commitUTXOs": [commit],
            "network": "LTCTEST",
        }),
    );
    // psbt construction fails on the fake raw tx, which must be reported, not swallowed
    assert_eq!(r.status, 500);
    assert!(r.body["error"].as_str().unwrap().starts_with("buildPsbt"));
    let (_, params) = f
        .node
        .0
        .borrow()
        .calls
        .iter()
        .find(|(m, _)| m == "createrawtransaction")
        .cloned()
        .unwrap();
    // inputs: mandatory commit first, then the largest wallet utxo
    assert_eq!(params[0][0]["txid"], txid(9));
    assert_eq!(params[0][1]["txid"], txid(1));
    assert_eq!(params[1][TO].as_f64().unwrap(), 0.000036);
}

// ---------------- signing ----------------

#[test]
fn repaired_sign_routes_are_guarded_and_only_then_reach_the_signer() {
    let mut f = fixture();
    start_node(&mut f);
    // an unsignable (garbage) tx never reaches the signer
    let r = call(
        &mut f,
        "/api/sign-tx",
        json!({"rawtx":"zz","wif":"synthetic","network":"LTCTEST","inputs":[]}),
    );
    assert_eq!(r.status, 500);
    let r = call(
        &mut f,
        "/api/sign-psbt",
        json!({"psbtHex":"00","wif":"synthetic","network":"LTCTEST"}),
    );
    assert_eq!(r.status, 500);
    assert!(f.signer.0.borrow().signed_tx.is_empty());
    assert!(f.signer.0.borrow().signed_psbt.is_empty());
    // absolute fee ceiling for a caller-approved maxFee
    let r = call(
        &mut f,
        "/api/sign-tx",
        json!({"rawtx":"00","wif":"w","network":"LTCTEST","inputs":[],"maxFee":"1.5"}),
    );
    assert_eq!(r.body["error"], "maxFee above absolute ceiling");
    let r = call(
        &mut f,
        "/api/sign-tx",
        json!({"rawtx":"00","wif":"w","network":"LTCTEST","inputs":[],"maxFee":0.5}),
    );
    assert_eq!(r.body["error"], "maxFee must be a decimal string");
}

fn spend_hex(output_sat: u64) -> String {
    use bitcoin::absolute::LockTime;
    use bitcoin::transaction::Version;
    use bitcoin::{OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid, Witness};
    use std::str::FromStr;
    let t = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint {
                txid: Txid::from_str(&txid(1)).unwrap(),
                vout: 0,
            },
            script_sig: ScriptBuf::new(),
            sequence: Sequence::MAX,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: bitcoin::Amount::from_sat(output_sat),
            script_pubkey: ScriptBuf::from_bytes(
                vec![0x00, 0x14].into_iter().chain([7u8; 20]).collect(),
            ),
        }],
    };
    tl_wallet_service::psbt::tx_to_hex(&t)
}

#[test]
fn sign_tx_reaches_the_signer_only_after_the_guard_passes() {
    let mut f = fixture();
    start_node(&mut f);
    f.node.script("gettxout", json!({"value": 0.01}));
    let input = json!([{"txid": txid(1), "vout": 0, "amount": 0.01, "confirmations": 3, "scriptPubKey": "0014aa"}]);
    let body = |out: u64, inputs: Value| json!({"rawtx": spend_hex(out), "wif": "synthetic", "network": "LTCTEST", "inputs": inputs});
    // fee = 0.0006 = the default bound for one input: signed
    let r = call(&mut f, "/api/sign-tx", body(940_000, input.clone()));
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(f.signer.0.borrow().signed_tx.len(), 1);
    // one satoshi more fee: refused, signer untouched
    let r = call(&mut f, "/api/sign-tx", body(939_999, input.clone()));
    assert_eq!(r.status, 500);
    assert!(r.body["error"].as_str().unwrap().starts_with("sign guard"));
    // the caller may approve a higher fee explicitly
    let mut b = body(939_999, input.clone());
    b["maxFee"] = json!("0.00061");
    assert_eq!(call(&mut f, "/api/sign-tx", b).status, 200);
    assert_eq!(f.signer.0.borrow().signed_tx.len(), 2);
    // understated input amount (segwit fee attack) is caught against the chain view
    let lie = json!([{"txid": txid(1), "vout": 0, "amount": 0.0001, "confirmations": 3, "scriptPubKey": "0014aa"}]);
    let r = call(&mut f, "/api/sign-tx", body(50, lie));
    assert_eq!(r.status, 500);
    assert_eq!(f.signer.0.borrow().signed_tx.len(), 2);
    // approved maxFee has an absolute ceiling and must be a string
    let mut b = body(940_000, input.clone());
    b["maxFee"] = json!("1.5");
    assert_eq!(
        call(&mut f, "/api/sign-tx", b).body["error"],
        "maxFee above absolute ceiling"
    );
    let mut b = body(940_000, input);
    b["maxFee"] = json!(0.5);
    assert_eq!(
        call(&mut f, "/api/sign-tx", b).body["error"],
        "maxFee must be a decimal string"
    );
}
