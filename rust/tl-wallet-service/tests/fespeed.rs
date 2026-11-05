//! FE-speed's routes behind the gate: `/tlraw/*`, `/tl/*`, the `/api` additions and the changed
//! `rpc-call` / `start-wallet-node`, against the in-memory node and listener.

use serde_json::{json, Value};
use tl_wallet_service::gate::*;
use tl_wallet_service::mem::*;
use tl_wallet_service::service::*;

const TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const A: &str = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const B: &str = "03f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

struct Fx {
    svc: WalletService,
    node: MemRpc,
    store: MemStore,
    listener: MemListener,
}

fn fixture() -> Fx {
    let gate = Gate::new(GateConfig {
        port: 1986,
        token: SessionToken::from_hex(TOKEN).unwrap(),
        allowed_origins: vec!["file://".into()],
        methods: MethodAllowlist::wallet_default(),
    });
    let store = MemStore::default();
    store.0.borrow_mut().dirs.insert("/home/u/.litecoin".into());
    store.0.borrow_mut().files.insert(
        "/home/u/.litecoin/litecoin.conf".into(),
        "rpcuser=u\nrpcpassword=p\nrpcport=19332\n".into(),
    );
    let connector = MemConnector::default();
    let listener = MemListener::default();
    let mut svc = WalletService::new(
        gate,
        Box::new(MemKeys),
        Box::new(MemSigner::default()),
        Box::new(store.clone()),
        Box::new(connector.clone()),
        Box::new(MemRelayer::default()),
        vec![],
        "/home/u/.litecoin".into(),
    );
    svc.set_listener(Box::new(listener.clone()));
    Fx {
        svc,
        node: connector.node.clone(),
        store,
        listener,
    }
}

fn req(method: &str, path: &str, query: &str, body: Value) -> HttpRequest {
    let mut r = HttpRequest::post(path, TOKEN, body);
    r.method = method.into();
    r.query = query.into();
    r.host = Some("localhost:1986".into());
    r.origin = Some("file://".into());
    r
}

fn post(f: &mut Fx, path: &str, body: Value) -> HttpResponse {
    f.svc.handle(&req("POST", path, "", body))
}

fn get(f: &mut Fx, path: &str, query: &str) -> HttpResponse {
    f.svc.handle(&req("GET", path, query, Value::Null))
}

fn start_node(f: &mut Fx) {
    f.node
        .script("getblockchaininfo", json!({"blocks": 120, "headers": 150}));
    let r = post(
        f,
        "/api/start-wallet-node",
        json!({"network":"LTCTEST","path":"/home/u/.litecoin"}),
    );
    assert_eq!(
        r.body,
        json!({"data": true, "attached": true}),
        "{:?}",
        r.body
    );
}

// ---------------------------------------------------------------- gate

#[test]
fn every_new_route_requires_the_session_token_and_never_reaches_the_listener() {
    let mut f = fixture();
    let routes: &[(&str, &str)] = &[
        ("POST", "/tlraw/tl_getSyncStatus"),
        ("GET", "/tlraw/tl_getContractInfo"),
        ("POST", "/tl/getChannel"),
        ("POST", "/tl/test"),
        ("POST", "/tl/init"),
        ("POST", "/api/compute-multisig"),
        ("POST", "/api/init-tradelayer"),
        ("GET", "/api/tradelayer/sync-status"),
        ("GET", "/api/tradelayer/collator-status"),
        ("POST", "/api/tradelayer/set-collator-config"),
        ("GET", "/explorer/api/overview"),
        ("POST", "/api/algo/run"),
        ("POST", "/api/build-bitvm-dlc-setup"),
    ];
    for (m, p) in routes {
        let mut r = req(m, p, "", json!({}));
        r.token = None;
        assert_eq!(f.svc.handle(&r).status, 401, "{p}");
        let mut r = req(m, p, "", json!({}));
        r.token = Some("11".repeat(32));
        assert_eq!(f.svc.handle(&r).status, 401, "{p}");
        let mut r = req(m, p, "", json!({}));
        r.origin = Some("https://evil.example".into());
        assert_eq!(f.svc.handle(&r).status, 403, "{p}");
        let mut r = req(m, p, "", json!({}));
        r.host = Some("evil.example:1986".into());
        assert_eq!(f.svc.handle(&r).status, 403, "{p}");
        let mut r = req(m, p, "", json!({}));
        r.peer_is_loopback = false;
        assert_eq!(f.svc.handle(&r).status, 403, "{p}");
    }
    assert_eq!(f.listener.total_calls(), 0);
}

#[test]
fn preflight_for_the_new_routes_needs_no_token_and_no_listener() {
    let mut f = fixture();
    let mut r = req("OPTIONS", "/tlraw/tl_getContractInfo", "", Value::Null);
    r.token = None;
    let resp = f.svc.handle(&r);
    assert_eq!(resp.status, 204);
    assert_eq!(resp.allow_origin.as_deref(), Some("file://"));
    assert_eq!(f.listener.total_calls(), 0);
}

// ---------------------------------------------------------------- /tlraw/

#[test]
fn tlraw_forwards_post_verbatim_and_returns_the_listener_status_and_body() {
    let mut f = fixture();
    f.listener
        .script("POST", "tl_getChannelColumn", 200, json!({"column": "A"}));
    let body = json!({"channelAddress":"c","buyerAddress":"b","cpAddress":"p"});
    let r = post(&mut f, "/tlraw/tl_getChannelColumn", body.clone());
    assert_eq!((r.status, r.body), (200, json!({"column": "A"})));
    let calls = f.listener.calls_of("tl_getChannelColumn");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "POST");
    assert_eq!(calls[0].body, Some(body));
    assert_eq!(calls[0].timeout, std::time::Duration::from_secs(60));
    // a listener error status and its body pass through
    f.listener.script(
        "POST",
        "tl_listContractSeries",
        429,
        json!({"error":"slow down"}),
    );
    let r = post(
        &mut f,
        "/tlraw/tl_listContractSeries",
        json!({"contractId": 3}),
    );
    assert_eq!((r.status, r.body), (429, json!({"error":"slow down"})));
    // no body: none is sent
    f.listener
        .script("POST", "tl_listProperties", 200, json!([]));
    post(&mut f, "/tlraw/tl_listProperties", Value::Null);
    assert_eq!(f.listener.calls_of("tl_listProperties")[0].body, None);
}

#[test]
fn tlraw_forwards_get_with_the_query() {
    let mut f = fixture();
    f.listener
        .script("GET", "tl_getContractInfo", 200, json!({"contractId": 3}));
    let r = get(&mut f, "/tlraw/tl_getContractInfo", "contractId=3");
    assert_eq!((r.status, r.body), (200, json!({"contractId": 3})));
    let c = &f.listener.calls_of("tl_getContractInfo")[0];
    assert_eq!(
        (c.method.as_str(), c.query.as_str(), &c.body),
        ("GET", "contractId=3", &None)
    );
}

#[test]
fn tlraw_refuses_what_is_not_on_the_allowlist() {
    let mut f = fixture();
    f.listener.script("POST", "tl_initmain", 200, json!({}));
    f.listener
        .script("GET", "tl_contractPosition", 200, json!({}));
    // wrong verb
    assert_eq!(get(&mut f, "/tlraw/tl_initmain", "").status, 405);
    assert_eq!(
        post(&mut f, "/tlraw/tl_contractPosition", json!({})).status,
        405
    );
    // unknown endpoints, traversal, near misses
    for p in [
        "/tlraw/tl_shutdown",
        "/tlraw/",
        "/tlraw/tl_getsyncstatus",
        "/tlraw/../tl_initmain",
        "/tlraw/tl_initmain/x",
        "/tlraw/tl_initmain?x=1",
        "/tlraw/http://evil.example/",
        "/tlraw//tl_initmain",
    ] {
        assert_eq!(post(&mut f, p, json!({})).status, 404, "{p}");
    }
    // query with characters outside the allowed set or too long
    for q in ["a=1#frag", "a=1 b", "a=\u{e9}", "a=\n1", &"x".repeat(2049)] {
        assert_eq!(
            get(&mut f, "/tlraw/tl_contractPosition", q).status,
            400,
            "{q:?}"
        );
    }
    assert_eq!(f.listener.total_calls(), 0);
    // oversize body
    let mut r = req("POST", "/tlraw/tl_initmain", "", json!({}));
    r.body_len = MAX_BODY_BYTES + 1;
    assert_eq!(f.svc.handle(&r).status, 413);
    assert_eq!(f.listener.total_calls(), 0);
}

#[test]
fn tlraw_listener_down_is_a_502_with_the_error_text() {
    let mut f = fixture();
    let r = post(&mut f, "/tlraw/tl_getSyncStatus", json!({}));
    assert_eq!(r.status, 502);
    assert_eq!(
        r.body,
        json!({"error": "connect ECONNREFUSED 127.0.0.1:3000"})
    );
    f.listener
        .script_error("GET", "tl_getMaxSynth", "response too large");
    let r = get(&mut f, "/tlraw/tl_getMaxSynth", "address=a&propId=1");
    assert_eq!(
        (r.status, r.body),
        (502, json!({"error": "response too large"}))
    );
}

#[test]
fn tlraw_without_a_listener_is_a_502() {
    let gate = Gate::new(GateConfig {
        port: 1986,
        token: SessionToken::from_hex(TOKEN).unwrap(),
        allowed_origins: vec!["file://".into()],
        methods: MethodAllowlist::wallet_default(),
    });
    let mut svc = WalletService::new(
        gate,
        Box::new(MemKeys),
        Box::new(MemSigner::default()),
        Box::new(MemStore::default()),
        Box::new(MemConnector::default()),
        Box::new(MemRelayer::default()),
        vec![],
        "/x".into(),
    );
    let r = svc.handle(&req("POST", "/tlraw/tl_getSyncStatus", "", json!({})));
    assert_eq!(r.status, 502);
    assert!(r.body["error"].as_str().unwrap().contains("not configured"));
}

// ---------------------------------------------------------------- /tl/*

#[test]
fn tl_routes_forward_the_way_fe_speed_does() {
    let mut f = fixture();
    let l = f.listener.clone();

    l.script(
        "POST",
        "tl_getAllBalancesForAddress",
        200,
        json!([{"propertyId": 1}]),
    );
    let r = post(
        &mut f,
        "/tl/getAllBalancesForAddress",
        json!({"params": ["addr1"]}),
    );
    assert_eq!((r.status, r.body), (200, json!([{"propertyId": 1}])));
    assert_eq!(
        l.calls_of("tl_getAllBalancesForAddress")[0].body,
        Some(json!({"params": "addr1"}))
    );

    l.script("POST", "tl_getChannel", 200, json!({"channel": "c1"}));
    // FE-speed's bare-array body and the {params:[address]} body the UI sends
    for body in [json!(["addr2"]), json!({"params": ["addr2"]})] {
        let r = post(&mut f, "/tl/getChannel", body);
        assert_eq!((r.status, r.body), (200, json!({"channel": "c1"})));
    }
    assert!(l
        .calls_of("tl_getChannel")
        .iter()
        .all(|c| c.body == Some(json!({"params": "addr2"}))));

    l.script("POST", "tl_getChannelColumn", 200, json!({"column": "B"}));
    for body in [
        json!({"channelAddress":"c","newCommitAddress":"n","cpAddress":"p"}),
        json!({"channel":"c","myAddress":"n","cpAddr":"p"}),
        json!({"buyerAddress":"n","channelAddress":"c","cpAddress":"p"}),
        json!({"params": ["c", "n", "p"]}),
        json!(["c", "n", "p"]),
    ] {
        let r = post(&mut f, "/tl/getChannelColumn", body.clone());
        assert_eq!(
            (r.status, r.body.clone()),
            (200, json!({"column": "B"})),
            "{body}"
        );
    }
    assert!(l
        .calls_of("tl_getChannelColumn")
        .iter()
        .all(|c| c.body
            == Some(json!({"channelAddress":"c","newCommitAddress":"n","cpAddress":"p"}))));
    let r = post(
        &mut f,
        "/tl/getChannelColumn",
        json!({"channelAddress":"c"}),
    );
    assert_eq!(r.status, 400);
    assert_eq!(
        r.body,
        json!("channelAddress, newCommitAddress, and cpAddress are required")
    );

    l.script("POST", "tl_listProperties", 200, Value::Null);
    let r = post(&mut f, "/tl/listProperties", Value::Null);
    assert_eq!((r.status, r.body), (200, json!([])));
    l.script("POST", "tl_listProperties", 200, json!([{"id": 1}]));
    assert_eq!(
        post(&mut f, "/tl/listProperties", json!({})).body,
        json!([{"id": 1}])
    );

    l.script("POST", "tl_getProperty", 200, json!({"id": 7}));
    let r = post(&mut f, "/tl/getProperty", json!({"params": [7]}));
    assert_eq!(r.body, json!({"id": 7}));
    assert_eq!(
        l.calls_of("tl_getProperty")[0].body,
        Some(json!({"params": 7}))
    );
    let r = post(&mut f, "/tl/getProperty", json!({"params": 8}));
    assert_eq!(r.status, 200);
    assert_eq!(
        l.calls_of("tl_getProperty")[1].body,
        Some(json!({"params": 8}))
    );

    l.script("POST", "tl_getMaxProcessedHeight", 200, json!(0));
    assert_eq!(
        post(&mut f, "/tl/getMaxProcessedHeight", Value::Null).body,
        json!(0)
    );
    l.script("POST", "tl_getMaxParsedHeight", 200, json!(812));
    assert_eq!(
        post(&mut f, "/tl/getMaxParsedHeight", Value::Null).body,
        json!(812)
    );

    l.script("GET", "tl_contractPosition", 200, json!({"position": 5}));
    let r = post(
        &mut f,
        "/tl/contractPosition",
        json!({"params": {"address": "tltc1q a&b", "contractId": 3}}),
    );
    assert_eq!((r.status, r.body), (200, json!({"position": 5})));
    let c = &l.calls_of("tl_contractPosition")[0];
    assert_eq!(c.method, "GET");
    assert_eq!(c.query, "address=tltc1q%20a%26b&contractId=3");
    let r = post(&mut f, "/tl/contractPosition", json!({}));
    assert_eq!(r.status, 500);
    assert!(r.body["error"].as_str().unwrap().contains("params"));

    l.script("POST", "tl_loadWallet", 200, Value::Null);
    assert_eq!(post(&mut f, "/tl/loadWallet", Value::Null).body, json!(0));

    l.script("POST", "tl_getStateSnapshot", 200, json!({"height": 1}));
    post(&mut f, "/tl/stateSnapshot", json!({}));
    post(&mut f, "/tl/stateSnapshot", json!({"label": "  mine "}));
    let snaps = l.calls_of("tl_getStateSnapshot");
    assert_eq!(snaps[0].body, Some(json!({"label": "TL"})));
    assert_eq!(snaps[1].body, Some(json!({"label": "mine"})));

    l.script("POST", "tl_getAttestations", 200, Value::Null);
    let r = post(&mut f, "/tl/getAttestations", json!({"params": ["a", 3]}));
    assert_eq!((r.status, r.body), (200, json!([])));
    assert_eq!(
        l.calls_of("tl_getAttestations")[0].body,
        Some(json!({"address": "a", "id": 3}))
    );

    let r = post(&mut f, "/tl/test", json!({}));
    assert_eq!(r.body, json!({"message": "Test route working"}));
}

#[test]
fn tl_routes_answer_500_with_fe_speeds_error_text_when_the_listener_is_down() {
    let mut f = fixture();
    for (route, body) in [
        ("getAllBalancesForAddress", json!({"params": ["a"]})),
        ("getChannel", json!({"params": ["a"]})),
        ("listProperties", json!({})),
        ("getProperty", json!({"params": [1]})),
        ("getMaxProcessedHeight", json!({})),
        ("getMaxParsedHeight", json!({})),
        ("loadWallet", json!({})),
        ("stateSnapshot", json!({})),
        ("getAttestations", json!({"params": ["a", 1]})),
        ("getChannelColumn", json!({"params": ["c", "n", "p"]})),
    ] {
        let r = post(&mut f, &format!("/tl/{route}"), body);
        assert_eq!(r.status, 500, "{route}");
        assert_eq!(
            r.body,
            json!("Error: connect ECONNREFUSED 127.0.0.1:3000"),
            "{route}"
        );
    }
    // a listener error status is an axios-style error
    f.listener
        .script("POST", "tl_getChannel", 500, json!({"error": "x"}));
    let r = post(&mut f, "/tl/getChannel", json!({"params": ["a"]}));
    assert_eq!(r.body, json!("Error: Request failed with status code 500"));
    // routes that report an object
    let r = post(&mut f, "/tl/init", json!({}));
    assert_eq!(r.status, 500);
    assert_eq!(
        r.body,
        json!({"error": "connect ECONNREFUSED 127.0.0.1:3000"})
    );
    let r = post(
        &mut f,
        "/tl/contractPosition",
        json!({"params": {"address": "a", "contractId": 1}}),
    );
    assert_eq!(r.status, 500);
    assert!(r.body["error"].as_str().unwrap().contains("ECONNREFUSED"));
}

#[test]
fn tl_init_initialises_once() {
    let mut f = fixture();
    f.listener
        .script("POST", "tl_initmain", 200, json!({"error": "not ready"}));
    let r = post(&mut f, "/tl/init", json!({}));
    assert_eq!((r.status, r.body), (500, json!({"error": "not ready"})));
    f.listener
        .script("POST", "tl_initmain", 200, json!({"ok": true}));
    let r = post(&mut f, "/tl/init", json!({}));
    assert_eq!(
        (r.status, r.body),
        (200, json!({"message": "TL Main initialized successfully"}))
    );
    assert_eq!(
        f.listener.calls_of("tl_initmain")[1].body,
        Some(json!({"wallet": true}))
    );
    // a second call is answered, and the listener is not asked again
    let r = post(&mut f, "/tl/init", json!({}));
    assert_eq!(r.status, 200);
    assert_eq!(f.listener.calls_of("tl_initmain").len(), 2);
}

#[test]
fn tl_routes_are_post_only_and_unknown_names_are_not_served() {
    let mut f = fixture();
    assert_eq!(get(&mut f, "/tl/test", "").status, 405);
    // names that are not FE-speed's routes reach the plain 404 of the service (the desktop
    // bridge answers those as node rpc-calls before it gets here)
    assert_eq!(post(&mut f, "/tl/tl_getproperty", json!({})).status, 404);
    assert_eq!(post(&mut f, "/tl/getproperty", json!({})).status, 404);
    assert!(is_tl_route("getChannel") && !is_tl_route("getchannel"));
}

// ---------------------------------------------------------------- rpc-call

#[test]
fn rpc_call_routes_wallet_methods_by_label_and_others_to_the_default_wallet() {
    let mut f = fixture();
    start_node(&mut f);
    f.node.script("getaddressesbylabel", json!({"addr": {}}));
    f.node.script("getblockchaininfo", json!({"blocks": 9}));
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"getaddressesbylabel","params":["tl-wallet"],"walletLabel":" w1 "}),
    );
    assert_eq!(r.body, json!({"data": {"addr": {}}}));
    let calls = f.node.0.borrow().wallet_calls.clone();
    assert_eq!(
        calls,
        vec![(
            "w1".to_string(),
            "getaddressesbylabel".to_string(),
            vec![json!("tl-wallet")]
        )]
    );
    // walletName wins over walletLabel; a non-wallet method ignores the label
    post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"getaddressesbylabel","params":["x"],"walletName":"n1","walletLabel":"w2"}),
    );
    assert_eq!(f.node.0.borrow().wallet_calls[1].0, "n1");
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"getblockchaininfo","walletLabel":"w1"}),
    );
    assert_eq!(r.body, json!({"data": {"blocks": 9}}));
    assert_eq!(f.node.0.borrow().wallet_calls.len(), 2);
    // empty label: the default wallet
    post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"getaddressesbylabel","params":["x"],"walletLabel":""}),
    );
    assert_eq!(f.node.0.borrow().wallet_calls.len(), 2);
    // a label with control characters is refused before any node call
    let before = f.node.total_calls();
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"listwallets","walletLabel":"a\nb"}),
    );
    assert_eq!(r.status, 500);
    assert_eq!(f.node.total_calls(), before);
}

#[test]
fn rpc_call_keeps_the_node_error_code_for_wallet_calls_too() {
    let mut f = fixture();
    start_node(&mut f);
    f.node
        .script_error("loadwallet", -18, "Wallet file not found");
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"loadwallet","params":["w"],"walletLabel":"w"}),
    );
    assert_eq!(r.status, 200);
    assert_eq!(r.body["EECode"], json!(-18));
    assert_eq!(r.body["error"], json!("Wallet file not found"));
}

#[test]
fn widened_allowlist_serves_the_ui_methods_and_still_refuses_signing() {
    let mut f = fixture();
    start_node(&mut f);
    for m in [
        "listwallets",
        "listlabels",
        "getwalletinfo",
        "getrawmempool",
        "gettransaction",
        "getblockcount",
        "getrawtransaction",
        "finalizepsbt",
        "tl_loadwallet",
    ] {
        f.node.script(m, json!("ok"));
        let r = post(&mut f, "/api/rpc-call", json!({"method": m, "params": []}));
        assert_eq!(r.body, json!({"data": "ok"}), "{m}");
    }
    let before = f.node.total_calls();
    for m in [
        "signrawtransactionwithkey",
        "walletprocesspsbt",
        "dumpwallet",
        "importprivkey",
        "sendtoaddress",
        "stop",
        "TL_LOADWALLET",
    ] {
        let r = post(&mut f, "/api/rpc-call", json!({"method": m, "params": []}));
        assert_eq!(r.status, 403, "{m}");
    }
    assert_eq!(f.node.total_calls(), before);
}

#[test]
fn rpc_call_while_the_node_loads_answers_200_with_the_error_then_attaches() {
    let mut f = fixture();
    f.node
        .script_error("getblockchaininfo", -28, "Loading block index...");
    let r = post(
        &mut f,
        "/api/start-wallet-node",
        json!({"network":"LTCTEST","path":"/home/u/.litecoin"}),
    );
    assert_eq!(
        (r.status, r.body),
        (
            200,
            json!({"data": true, "attached": false, "starting": true, "message": "Loading block index..."})
        )
    );
    assert!(!f.svc.node_connected());
    assert!(f.svc.has_pending_node());
    // the UI polls rpc-call: HTTP 200 and the error text, not a 500
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"getblockchaininfo"}),
    );
    assert_eq!(
        (r.status, r.body),
        (
            200,
            json!({"error": "Loading block index...", "starting": true})
        )
    );
    // the node finishes loading: the next call attaches and answers
    f.node.0.borrow_mut().rpc_errors.clear();
    f.node
        .script("getblockchaininfo", json!({"blocks": 5, "headers": 5}));
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"getblockchaininfo"}),
    );
    assert_eq!(r.body, json!({"data": {"blocks": 5, "headers": 5}}));
    assert!(f.svc.node_connected());
    assert!(!f.svc.has_pending_node());
}

#[test]
fn a_pending_node_attaches_in_the_background_poll() {
    let mut f = fixture();
    f.node
        .script_error("getblockchaininfo", -28, "Verifying blocks...");
    post(
        &mut f,
        "/api/start-wallet-node",
        json!({"network":"LTCTEST","path":"/home/u/.litecoin"}),
    );
    assert!(f.svc.has_pending_node());
    f.svc.poll_pending_node();
    assert!(f.svc.has_pending_node());
    f.node.0.borrow_mut().rpc_errors.clear();
    f.node.script("getblockchaininfo", json!({"blocks": 1}));
    f.svc.poll_pending_node();
    assert!(f.svc.node_connected());
    assert!(!f.svc.has_pending_node());
    // stop clears a pending connection too
    f.node.script("stop", json!("bye"));
    post(&mut f, "/api/stop-wallet-node", json!({}));
    assert!(!f.svc.node_connected());
}

#[test]
fn start_wallet_node_failures_are_200_with_the_error_the_ui_reads() {
    let mut f = fixture();
    // missing conf: the UI opens its "create litecoin.conf" dialog on this text
    f.store
        .0
        .borrow_mut()
        .files
        .remove("/home/u/.litecoin/litecoin.conf");
    let r = post(&mut f, "/api/start-wallet-node", json!({"network":"LTC"}));
    assert_eq!(r.status, 200);
    let e = r.body["error"].as_str().unwrap();
    assert!(
        e.contains("Config file") && e.contains("doesn't exist in"),
        "{e}"
    );
    // rejected credentials
    f.store.0.borrow_mut().files.insert(
        "/home/u/.litecoin/litecoin.conf".into(),
        "rpcuser=u\nrpcpassword=p\n".into(),
    );
    f.node.script_error("getblockchaininfo", -1, "Unauthorized");
    let r = post(&mut f, "/api/start-wallet-node", json!({"network":"LTC"}));
    assert_eq!(r.status, 200);
    assert!(r.body["error"]
        .as_str()
        .unwrap()
        .contains("rejected the wallet RPC credentials"));
    assert!(!f.svc.node_connected());
    // any other answer
    f.node
        .script_error("getblockchaininfo", -5, "Something odd");
    let r = post(&mut f, "/api/start-wallet-node", json!({"network":"LTC"}));
    assert!(r.body["error"]
        .as_str()
        .unwrap()
        .contains("unexpected error: Something odd"));
}

#[test]
fn allow_rescan_is_recorded_per_start() {
    let mut f = fixture();
    f.node.script("getblockchaininfo", json!({"blocks": 1}));
    assert!(!f.svc.rescan_opt_in());
    post(
        &mut f,
        "/api/start-wallet-node",
        json!({"network":"LTC","allowRescan":true}),
    );
    assert!(f.svc.rescan_opt_in());
    post(
        &mut f,
        "/api/start-wallet-node",
        json!({"network":"LTC","allowRescan":false}),
    );
    assert!(!f.svc.rescan_opt_in());
}

#[test]
fn tl_methods_go_to_the_node_by_default_and_to_fe_speeds_paths_in_listener_mode() {
    let mut f = fixture();
    start_node(&mut f);
    f.node.script("tl_getinfo", json!({"node": true}));
    // default mode: the node, as the 2024 UI expects
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"tl_getinfo","params":[]}),
    );
    assert_eq!(r.body, json!({"data": {"node": true}}));
    assert_eq!(f.listener.total_calls(), 0);
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"tl_createpayload_simplesend","params":[{"address":"a","propertyId":1,"amount":"2"}]}),
    );
    assert_eq!(r.status, 200);
    assert_eq!(f.listener.total_calls(), 0);

    f.svc.set_tl_rpc_via_listener(true);
    // local encoder: {data: payload}, no listener call
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"tl_createpayload_simplesend","params":[{"address":"tltc1qdest","propertyId":6,"amount":"100"}]}),
    );
    assert_eq!(r.body, json!({"data": "tl20;tltc1qdest;6;4ldqpds"}));
    assert_eq!(f.listener.total_calls(), 0);
    // an encoder error is a 500
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"tl_createpayload_simplesend","params":[null]}),
    );
    assert_eq!(r.status, 500);
    // any other tl_* goes to the listener with the request body, answered verbatim
    f.listener
        .script("POST", "tl_getproperty", 200, json!({"data": {"id": 1}}));
    let body = json!({"method":"tl_getproperty","params":[1]});
    let r = post(&mut f, "/api/rpc-call", body.clone());
    assert_eq!((r.status, r.body), (200, json!({"data": {"id": 1}})));
    assert_eq!(f.listener.calls_of("tl_getproperty")[0].body, Some(body));
    // listener down: a connection error is transient (HTTP 200 + error), anything else a 500
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"tl_isaddresswinner","params":["a"]}),
    );
    assert_eq!(r.status, 200);
    assert!(r.body["error"].as_str().unwrap().contains("ECONNREFUSED"));
    f.listener
        .script("POST", "tl_listnodereward_addresses", 500, json!({}));
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"tl_listnodereward_addresses"}),
    );
    assert_eq!(r.status, 500);
    // the node is not touched by any of it
    assert_eq!(f.node.calls_of("tl_getproperty"), 0);
}

#[test]
fn kyc_and_commit_checks_are_protocol_queries_answered_by_the_listener_in_both_modes() {
    let mut f = fixture();
    start_node(&mut f);
    f.node.script("tl_check_kyc", json!({"node": true}));
    f.listener.script(
        "POST",
        "tl_check_kyc",
        200,
        json!({"result: ": "enabled(kyc_0)"}),
    );
    let commits = json!([{"sender":"tltc1qa","channel":"tltc1qc","propertyId":"5","amount":"1.5","block":120}]);
    f.listener
        .script("POST", "tl_check_commits", 200, commits.clone());
    for via_listener in [false, true] {
        f.svc.set_tl_rpc_via_listener(via_listener);
        let r = post(
            &mut f,
            "/api/rpc-call",
            json!({"method":"tl_check_kyc","params":["tltc1qa"]}),
        );
        // the {data} envelope the 2024 UI reads as data['result: ']
        assert_eq!(
            (r.status, r.body),
            (200, json!({"data": {"result: ": "enabled(kyc_0)"}}))
        );
        let r = post(
            &mut f,
            "/api/rpc-call",
            json!({"method":"tl_check_commits","params":["tltc1qa"]}),
        );
        assert_eq!((r.status, r.body), (200, json!({ "data": commits })));
    }
    // the listener gets {address}, never the node
    assert_eq!(
        f.listener.calls_of("tl_check_kyc")[0].body,
        Some(json!({"address": "tltc1qa"}))
    );
    assert_eq!(f.listener.calls_of("tl_check_commits").len(), 2);
    assert_eq!(f.node.calls_of("tl_check_kyc"), 0);
    // one address string is the only accepted parameter
    for params in [json!([]), json!([""]), json!([1]), json!(["a", "b"])] {
        let r = post(
            &mut f,
            "/api/rpc-call",
            json!({"method":"tl_check_kyc","params":params}),
        );
        assert_eq!(r.status, 400, "{params}");
    }
    assert_eq!(f.listener.calls_of("tl_check_kyc").len(), 2);
    // a listener without the route (tl-rpcd adapter, tradelayer.js) is a 500 with its status
    f.listener.script(
        "POST",
        "tl_check_commits",
        404,
        json!({"error": "not_found"}),
    );
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method":"tl_check_commits","params":["tltc1qa"]}),
    );
    assert_eq!(r.status, 500);
}

// ---------------------------------------------------------------- compute-multisig

#[test]
fn compute_multisig_route_answers_data_or_a_500_error() {
    let mut f = fixture();
    let r = post(
        &mut f,
        "/api/compute-multisig",
        json!({"m": 2, "pubKeys": [B, A], "network": "LTCTEST"}),
    );
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body["data"]["address"],
        json!("tltc1q64zgzwlkupxx8kgqwq8j5d2lravzzxd7yd6d2kphduh9zzerynns7xfcpe")
    );
    assert_eq!(r.body["data"]["pubKeys"], json!([A, B]));
    let r = post(
        &mut f,
        "/api/compute-multisig",
        json!({"m": 3, "pubKeys": [A, B], "network": "LTC"}),
    );
    assert_eq!(
        (r.status, r.body),
        (500, json!({"error": "Invalid pubKeys"}))
    );
    let r = post(
        &mut f,
        "/api/compute-multisig",
        json!({"m": 1, "pubKeys": [A]}),
    );
    assert_eq!(
        (r.status, r.body),
        (500, json!({"error": "Unknown network: undefined"}))
    );
}

// ---------------------------------------------------------------- tradelayer status routes

#[test]
fn init_tradelayer_reports_listener_reachability() {
    let mut f = fixture();
    let r = post(&mut f, "/api/init-tradelayer", json!({}));
    assert_eq!(r.status, 500);
    let e = r.body["error"].as_str().unwrap();
    assert!(e.contains("did not become reachable"), "{e}");
    assert!(e.contains("http://127.0.0.1:3000"));
    f.listener
        .script("POST", "tl_getSyncStatus", 200, json!({"phase": "waiting"}));
    let r = post(&mut f, "/api/init-tradelayer", json!({}));
    assert_eq!(
        (r.status, r.body),
        (200, json!({"success": true, "result": true}))
    );
    // a listener that answers with an error status is not reachable
    f.listener
        .script("POST", "tl_getSyncStatus", 503, json!({}));
    assert_eq!(post(&mut f, "/api/init-tradelayer", json!({})).status, 500);
}

#[test]
fn sync_status_without_listener_or_node_is_starting_and_unreachable() {
    let mut f = fixture();
    let r = get(&mut f, "/api/tradelayer/sync-status", "");
    assert_eq!(r.status, 200);
    let d = &r.body["data"];
    assert_eq!(d["listenerReachable"], json!(false));
    assert!(d["listenerError"]
        .as_str()
        .unwrap()
        .contains("ECONNREFUSED"));
    assert_eq!(d["phase"], json!("starting"));
    assert_eq!(d["initialized"], json!(false));
    assert_eq!(d["listenerUrl"], json!("http://127.0.0.1:3000"));
    assert_eq!(d["nodeBlock"], Value::Null);
    assert_eq!(d["percent"], json!(0.0));
}

#[test]
fn sync_status_merges_the_node_and_the_listener() {
    let mut f = fixture();
    start_node(&mut f);
    f.listener.script(
        "POST",
        "tl_getSyncStatus",
        200,
        json!({"phase": "indexing", "initialized": true, "genesisBlock": 100, "percent": 0.5,
               "message": " busy "}),
    );
    f.listener.script(
        "POST",
        "tl_getMaxParsedHeight",
        200,
        json!({"maxParsedHeight": 90}),
    );
    f.listener
        .script("POST", "tl_getMaxProcessedHeight", 200, json!(80));
    f.listener
        .script("POST", "tl_getTrackHeight", 200, json!({"trackHeight": 70}));
    let r = get(&mut f, "/api/tradelayer/sync-status", "");
    let d = &r.body["data"];
    assert_eq!(d["listenerReachable"], json!(true));
    assert_eq!(d["listenerError"], Value::Null);
    assert_eq!(d["initialized"], json!(true));
    assert_eq!(d["phase"], json!("indexing"));
    assert_eq!(d["message"], json!("busy"));
    assert_eq!(d["nodeBlock"], json!(120));
    assert_eq!(d["headerBlock"], json!(150));
    assert_eq!(d["parsedHeight"], json!(90));
    assert_eq!(d["processedHeight"], json!(80));
    assert_eq!(d["trackHeight"], json!(70));
    assert_eq!(d["currentHeight"], json!(120));
    assert_eq!(d["targetHeight"], json!(150));
    assert_eq!(d["genesisBlock"], json!(100));
    assert_eq!(d["percent"], json!(50.0));
    // a reachable, initialised listener is not initialised again
    assert_eq!(f.listener.calls_of("tl_initmain").len(), 0);
}

#[test]
fn sync_status_waiting_with_a_node_height_is_realtime_and_percent_is_derived() {
    let mut f = fixture();
    start_node(&mut f);
    f.listener.script(
        "POST",
        "tl_getSyncStatus",
        200,
        json!({"phase": "waiting", "initialized": true}),
    );
    let d = get(&mut f, "/api/tradelayer/sync-status", "").body["data"].clone();
    assert_eq!(d["phase"], json!("realtime"));
    assert_eq!(d["percent"], json!(80.0));
}

#[test]
fn sync_status_initialises_an_uninitialised_listener_once_the_node_answers() {
    let mut f = fixture();
    start_node(&mut f);
    f.listener.script(
        "POST",
        "tl_getSyncStatus",
        200,
        json!({"initialized": false}),
    );
    f.listener.script("POST", "tl_initmain", 200, json!({}));
    let d = get(&mut f, "/api/tradelayer/sync-status", "").body["data"].clone();
    assert_eq!(f.listener.calls_of("tl_initmain").len(), 1);
    assert_eq!(
        f.listener.calls_of("tl_initmain")[0].body,
        Some(json!({"wallet": true}))
    );
    assert_eq!(d["listenerReachable"], json!(true));
    // an init error is reported, the status is still returned
    f.listener
        .script("POST", "tl_initmain", 200, json!({"error": "no wallet"}));
    let d = get(&mut f, "/api/tradelayer/sync-status", "").body["data"].clone();
    assert_eq!(d["listenerError"], json!("no wallet"));
}

#[test]
fn sync_status_rate_limited_is_paused_and_a_dead_listener_keeps_the_last_heights() {
    let mut f = fixture();
    start_node(&mut f);
    f.listener.script(
        "POST",
        "tl_getSyncStatus",
        200,
        json!({"phase": "realtime", "initialized": true, "processedHeight": 77}),
    );
    get(&mut f, "/api/tradelayer/sync-status", "");
    f.listener
        .script("POST", "tl_getSyncStatus", 429, json!({}));
    let d = get(&mut f, "/api/tradelayer/sync-status", "").body["data"].clone();
    assert_eq!(d["phase"], json!("paused"));
    assert_eq!(d["listenerReachable"], json!(true));
    assert_eq!(d["processedHeight"], json!(77));
    f.listener.script_error(
        "POST",
        "tl_getSyncStatus",
        "connect ECONNREFUSED 127.0.0.1:3000",
    );
    let d = get(&mut f, "/api/tradelayer/sync-status", "").body["data"].clone();
    assert_eq!(d["listenerReachable"], json!(false));
    assert_eq!(d["phase"], json!("paused"));
    assert_eq!(d["processedHeight"], json!(77));
    assert!(d["listenerError"]
        .as_str()
        .unwrap()
        .contains("ECONNREFUSED"));
}

#[test]
fn sync_status_is_get_only() {
    let mut f = fixture();
    assert_eq!(
        post(&mut f, "/api/tradelayer/sync-status", json!({})).status,
        405
    );
    assert_eq!(
        post(&mut f, "/api/tradelayer/collator-status", json!({})).status,
        405
    );
    assert_eq!(get(&mut f, "/api/compute-multisig", "").status, 405);
    assert_eq!(get(&mut f, "/api/init-tradelayer", "").status, 405);
}

#[test]
fn collator_routes_report_inactive_in_fe_speeds_shape() {
    let mut f = fixture();
    let d = get(&mut f, "/api/tradelayer/collator-status", "").body["data"].clone();
    assert_eq!(d["autoContributeEnabled"], json!(false));
    assert_eq!(d["activePeers"], json!([]));
    assert_eq!(d["activePeerCount"], json!(0));
    assert_eq!(d["collatorUrls"], json!([]));
    assert_eq!(d["wsRelay"], Value::Null);
    assert!(d["shouldContributeReason"].is_string());
    assert!(d["peers"].is_array() && d["advertisedMethods"].is_array() && d["retry"].is_object());
    // the saved URLs are echoed, de-duplicated; nothing is ever contributed
    let r = post(
        &mut f,
        "/api/tradelayer/set-collator-config",
        json!({"collatorUrls": "wss://a.example/ws, wss://b.example/ws\nwss://a.example/ws", "autoContribute": true}),
    );
    assert_eq!(
        r.body,
        json!({"data": {"collatorUrls": ["wss://a.example/ws", "wss://b.example/ws"], "autoContributeEnabled": false}})
    );
    let d = get(&mut f, "/api/tradelayer/collator-status", "").body["data"].clone();
    assert_eq!(
        d["collatorUrls"],
        json!(["wss://a.example/ws", "wss://b.example/ws"])
    );
    let r = post(
        &mut f,
        "/api/tradelayer/set-collator-config",
        json!({"collatorUrls": ["ws://x y"]}),
    );
    assert_eq!(r.status, 500);
    let many: Vec<String> = (0..33).map(|i| format!("wss://h{i}.example/ws")).collect();
    let r = post(
        &mut f,
        "/api/tradelayer/set-collator-config",
        json!({"collatorUrls": many}),
    );
    assert_eq!(r.status, 500);
}

// ---------------------------------------------------------------- not available

#[test]
fn explorer_bitvm_algo_address_and_rpc_routes_answer_503() {
    let mut f = fixture();
    let routes: &[(&str, &str)] = &[
        ("GET", "/explorer/"),
        ("GET", "/explorer/api/overview"),
        ("GET", "/explorer/api/address/tltc1qabc"),
        ("POST", "/api/build-bitvm-dlc-setup"),
        ("POST", "/api/build-bitvm-dlc-tx"),
        ("POST", "/api/bitvm/sync-procedural"),
        ("POST", "/api/bitvm/watchtower/start"),
        ("GET", "/api/bitvm/watchtower/status"),
        ("GET", "/api/bitvm/watchtower/logs"),
        ("POST", "/api/algo/upload"),
        ("POST", "/api/algo/run"),
        ("POST", "/algo/stop"),
        ("POST", "/api/algo/allocate"),
        ("GET", "/api/algo/discovery"),
        ("GET", "/api/algo/running"),
        ("POST", "/api/algo/withdraw"),
        ("GET", "/api/algo/metrics"),
        ("GET", "/api/algo/trades/stream"),
        ("GET", "/address/validate/tltc1qabc"),
        ("POST", "/address/sync-watchonly"),
        ("POST", "/address/utxo/tltc1qabc"),
        ("GET", "/address/balance/tltc1qabc"),
        ("GET", "/address/faucet/tltc1qabc"),
        ("POST", "/rpc/getblockchaininfo"),
    ];
    for (m, p) in routes {
        let r = f.svc.handle(&req(m, p, "", json!({})));
        assert_eq!(r.status, 503, "{p}");
        assert_eq!(
            r.body,
            json!({"error": "not available in the desktop build"}),
            "{p}"
        );
    }
    assert_eq!(f.node.total_calls(), 0);
    assert_eq!(f.listener.total_calls(), 0);
    // everything else unknown is still a plain 404
    assert_eq!(post(&mut f, "/api/not-a-route", json!({})).status, 404);
    assert_eq!(
        post(&mut f, "/keys/new-wallet", json!({"network": "LTC"})).status,
        200
    );
}

// ---------------- signrawtransactionwithwallet behind the sign guard ----------------

fn spend_hex(output_sat: u64, inputs: u8) -> String {
    use bitcoin::absolute::LockTime;
    use bitcoin::transaction::Version;
    use bitcoin::{OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid, Witness};
    let t = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: (1..=inputs)
            .map(|n| TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_byte_array_for_test([n; 32]),
                    vout: 0,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            })
            .collect(),
        output: vec![TxOut {
            value: bitcoin::Amount::from_sat(output_sat),
            script_pubkey: ScriptBuf::from_bytes([&[0x00, 0x14][..], &[7u8; 20][..]].concat()),
        }],
    };
    tl_wallet_service::psbt::tx_to_hex(&t)
}

trait TxidTestExt {
    fn from_byte_array_for_test(b: [u8; 32]) -> Self;
}

impl TxidTestExt for bitcoin::Txid {
    fn from_byte_array_for_test(b: [u8; 32]) -> Self {
        use bitcoin::hashes::Hash;
        bitcoin::Txid::from_byte_array(b)
    }
}

#[test]
fn rpc_call_signs_with_the_node_wallet_only_after_the_guard() {
    let mut f = fixture();
    start_node(&mut f);
    f.node.script("gettxout", json!({"value": 0.01}));
    f.node.script(
        "signrawtransactionwithwallet",
        json!({"hex": "0200signed", "complete": true}),
    );
    // a spend with a normal fee: signed, answered in the node's own shape
    let raw = spend_hex(940_000, 1);
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method": "signrawtransactionwithwallet", "params": [raw], "walletLabel": "tl-wallet"}),
    );
    assert_eq!(
        r.body,
        json!({"data": {"hex": "0200signed", "complete": true}}),
        "{:?}",
        r.body
    );
    assert_eq!(f.node.calls_of("signrawtransactionwithwallet"), 1);
    assert_eq!(f.node.calls_of("gettxout"), 1);
    // the wallet label routed the signing call
    assert_eq!(
        f.node.0.borrow().wallet_calls.last().unwrap().1,
        "signrawtransactionwithwallet"
    );
    assert_eq!(
        f.node.0.borrow().wallet_calls.last().unwrap().0,
        "tl-wallet"
    );

    // fee above the ceiling: refused, the node never asked to sign
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method": "signrawtransactionwithwallet", "params": [spend_hex(900_000, 1)]}),
    );
    assert_eq!(r.status, 500);
    assert!(
        r.body["error"].as_str().unwrap().contains("sign guard"),
        "{:?}",
        r.body
    );
    // outputs above the chain amount
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method": "signrawtransactionwithwallet", "params": [spend_hex(2_000_000, 1)]}),
    );
    assert_eq!(r.status, 500);
    assert_eq!(f.node.calls_of("signrawtransactionwithwallet"), 1);
    // an input that is not an unspent output
    f.node.script("gettxout", Value::Null);
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method": "signrawtransactionwithwallet", "params": [spend_hex(1, 1)]}),
    );
    assert_eq!(r.status, 500);
    assert!(r.body["error"]
        .as_str()
        .unwrap()
        .contains("not an unspent output"));
    assert_eq!(f.node.calls_of("signrawtransactionwithwallet"), 1);
}

#[test]
fn rpc_call_signing_takes_only_the_raw_transaction() {
    let mut f = fixture();
    start_node(&mut f);
    f.node.script("gettxout", json!({"value": 0.01}));
    f.node.script(
        "signrawtransactionwithwallet",
        json!({"hex": "00", "complete": true}),
    );
    let raw = spend_hex(940_000, 1);
    for params in [
        json!([]),
        json!([raw.clone(), [{"txid": "00", "vout": 0}]]),
        json!([raw.clone(), [], "NONE"]),
        json!([5]),
    ] {
        let r = post(
            &mut f,
            "/api/rpc-call",
            json!({"method": "signrawtransactionwithwallet", "params": params}),
        );
        assert_eq!(r.status, 403, "{params}");
    }
    // junk hex stops at the guard; no node call at all
    let r = post(
        &mut f,
        "/api/rpc-call",
        json!({"method": "signrawtransactionwithwallet", "params": ["zz"]}),
    );
    assert_eq!(r.status, 500);
    assert_eq!(f.node.calls_of("signrawtransactionwithwallet"), 0);
    assert_eq!(f.node.calls_of("gettxout"), 0);
}

#[test]
fn compute_multisig_takes_the_prefix_of_a_connected_regtest_node() {
    let addr = |f: &mut Fx| {
        let r = post(
            f,
            "/api/compute-multisig",
            json!({"m": 2, "pubKeys": [B, A], "network": "LTCTEST"}),
        );
        assert_eq!(r.status, 200, "{:?}", r.body);
        r.body["data"]["address"].as_str().unwrap().to_string()
    };
    // no node connected: the label picks the prefix
    let mut f = fixture();
    assert!(addr(&mut f).starts_with("tltc1q"));
    // Bitcoin Core on regtest: the UI's network label cannot be what the node accepts
    let mut f = fixture();
    start_node(&mut f);
    f.node.script(
        "getblockchaininfo",
        json!({"blocks": 120, "headers": 150, "chain": "regtest"}),
    );
    f.node
        .script("getnetworkinfo", json!({"subversion": "/Satoshi:31.1.0/"}));
    let on_bitcoin = addr(&mut f);
    assert!(on_bitcoin.starts_with("bcrt1q"), "{on_bitcoin}");
    f.node.script(
        "getnetworkinfo",
        json!({"subversion": "/LitecoinCore:0.21.5/"}),
    );
    assert!(addr(&mut f).starts_with("rltc1q"));
    // a node that is not on regtest keeps the label's prefix
    let mut f = fixture();
    start_node(&mut f);
    f.node.script(
        "getblockchaininfo",
        json!({"blocks": 120, "headers": 150, "chain": "test"}),
    );
    assert!(addr(&mut f).starts_with("tltc1q"));
}
