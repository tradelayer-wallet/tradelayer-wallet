// End-to-end tests of the orderbook login: a mock orderbook (WebSocket and the `/auth` HTTP
// routes on one port, like the real server), the relay in a `socketio` thread or a `Manager`, and
// a UI driving it. Included into `tests`.

use crate::obauth::tests::{hub_with, test_address, AuthServer, TestSigner};
use crate::obauth::{AuthHub, AuthTiming};

fn auth_ui(m: &Mock, hub: &Arc<AuthHub>) -> Ui {
    let h = socketio::start_with_auth(
        Box::new(FakeNode),
        fast(),
        policy_for(m),
        quick(),
        Some(hub.clone()),
    )
    .unwrap();
    let mut ui = Ui {
        h,
        sid: String::new(),
        seen: Vec::new(),
    };
    ui.new_session();
    ui
}

fn mock_with_auth() -> (Mock, AuthServer) {
    let m = Mock::start();
    let srv = AuthServer::new();
    m.set_http(srv.handler());
    (m, srv)
}

fn default_hub() -> Arc<AuthHub> {
    hub_with(AuthTiming::default(), Box::new(TestSigner::new()))
}

fn order_for(address: &str, price: f64) -> Value {
    json!({"keypair": {"address": address, "pubkey": "02aa"}, "network": "LTCTEST",
           "type": "SPOT", "isLimitOrder": true, "action": "BUY",
           "props": {"id_for_sale": 4, "id_desired": 5, "amount": 1, "price": price}})
}

/// The token of the `n`th (1-based) `auth` frame the mock server received.
fn nth_auth(m: &Mock, n: usize) -> String {
    m.wait_for("an auth frame", |s| {
        s.received
            .iter()
            .filter_map(|t| serde_json::from_str::<Value>(t).ok())
            .filter(|v| v["event"] == "auth")
            .nth(n - 1)
            .map(|v| v["token"].as_str().unwrap().to_string())
    })
}

/// Play the server: confirm `token`'s address with `auth_ok`.
fn grant(m: &Mock, srv: &AuthServer, token: &str, lifetime_ms: u64) {
    let address = srv.address_of(token).expect("a token the server issued");
    m.send(
        &json!({"event": "auth_ok", "address": address,
                "expiresAt": crate::obauth::wall_ms() + lifetime_ms})
        .to_string(),
    );
}

fn orders_received(m: &Mock) -> usize {
    m.received_json()
        .iter()
        .filter(|v| v["event"] == "new-order")
        .count()
}

fn start_ui(m: &Mock, hub: &Arc<AuthHub>) -> Ui {
    let mut ui = auth_ui(m, hub);
    ui.emit(&connect_packet(&m.ws_url()));
    ui.wait_for("OB_SOCKET::connected");
    ui
}

#[test]
fn an_order_waits_for_the_login_and_is_forwarded_on_auth_ok() {
    let (m, srv) = mock_with_auth();
    let hub = default_hub();
    let mut ui = start_ui(&m, &hub);
    let addr = test_address(1);
    ui.emit(&encode_event("new-order", Some(&order_for(&addr, 1.5))));

    // The relay fetched a challenge, signed it, verified, and presented the token.
    let token = nth_auth(&m, 1);
    assert_eq!(srv.address_of(&token).as_deref(), Some(addr.as_str()));
    assert_eq!(
        srv.0.lock().unwrap().log,
        ["GET /auth/challenge", "POST /auth/verify"]
    );
    // The order is held until the server confirms.
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(orders_received(&m), 0);
    grant(&m, &srv, &token, 600_000);
    let sent = m.wait_received("the order", |v| v["event"] == "new-order");
    assert_eq!(sent["keypair"]["address"], json!(addr));
    assert_eq!(sent["props"]["price"], json!(1.5));

    // The UI is told `auth_ok` (no token) and never sees the token anywhere.
    let ok = ui.wait_for("OB_SOCKET::auth_ok");
    assert!(ok.contains(&addr), "{ok}");
    ui.assert_absent(&token, 300);
    assert!(ui.seen.iter().all(|p| !p.contains(&token)));
    assert!(!ok.contains("token"));
    // The token went to the server once, in the `auth` frame, and nowhere else.
    assert_eq!(
        m.received().iter().filter(|t| t.contains(&token)).count(),
        1
    );

    // A second order of the same address goes straight through.
    ui.emit(&encode_event("new-order", Some(&order_for(&addr, 2.5))));
    m.wait_received("the second order", |v| v["props"]["price"] == json!(2.5));
    assert_eq!(srv.0.lock().unwrap().challenge_count, 1);
    // Reads were never gated.
    ui.emit(r#"42["orderbook:join",{"marketKey":"4-5","network":"LTCTEST"}]"#);
    m.wait_received("join", |v| v["event"] == "orderbook:join");
}

#[test]
fn a_failed_login_tells_the_ui_and_forwards_nothing() {
    let (m, srv) = mock_with_auth();
    srv.0.lock().unwrap().fail_verify = Some((401, "signature invalid".into()));
    let hub = default_hub();
    let mut ui = start_ui(&m, &hub);
    let addr = test_address(2);
    ui.emit(&encode_event("new-order", Some(&order_for(&addr, 1.0))));
    let err = ui.wait_for("OB_SOCKET::order:error");
    assert!(err.contains("Orderbook login failed"), "{err}");
    assert!(err.contains("signature invalid"), "{err}");
    assert!(!err.contains("tok"), "{err}");
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(orders_received(&m), 0);
    assert!(m.received_json().iter().all(|v| v["event"] != "auth"));
    // During the cooldown the next order fails at once, without another challenge.
    let before = srv.0.lock().unwrap().challenge_count;
    ui.emit(&encode_event("new-order", Some(&order_for(&addr, 1.0))));
    ui.wait_for("OB_SOCKET::order:error");
    assert_eq!(srv.0.lock().unwrap().challenge_count, before);
}

#[test]
fn an_unknown_trading_address_fails_through_the_signer() {
    let (m, _srv) = mock_with_auth();
    let hub = default_hub();
    let mut ui = start_ui(&m, &hub);
    // Not one of the test keys: the signer refuses and the UI hears why.
    let stranger = {
        let sk = bitcoin::secp256k1::SecretKey::from_slice(&[77u8; 32]).unwrap();
        let pk = bitcoin::CompressedPublicKey(sk.public_key(&bitcoin::secp256k1::Secp256k1::new()));
        tl_wallet_core::Address::for_account_key(tl_wallet_core::Network::LtcTest, &pk)
            .encode()
            .unwrap()
    };
    ui.emit(&encode_event("new-order", Some(&order_for(&stranger, 1.0))));
    let err = ui.wait_for("OB_SOCKET::order:error");
    assert!(err.contains("signing failed"), "{err}");
}

#[test]
fn a_server_that_needs_no_login_is_not_asked_for_one() {
    let (m, srv) = mock_with_auth();
    m.st.0.lock().unwrap().auth_required = false;
    let hub = default_hub();
    let ui = start_ui(&m, &hub);
    let addr = test_address(3);
    ui.emit(&encode_event("new-order", Some(&order_for(&addr, 3.5))));
    m.wait_received("the order", |v| v["props"]["price"] == json!(3.5));
    assert_eq!(srv.0.lock().unwrap().challenge_count, 0);
    assert!(m.received_json().iter().all(|v| v["event"] != "auth"));
}

#[test]
fn after_a_reconnect_the_address_is_logged_in_again_before_the_next_order() {
    let (m, srv) = mock_with_auth();
    let hub = default_hub();
    let mut ui = start_ui(&m, &hub);
    let addr = test_address(1);
    ui.emit(&encode_event("new-order", Some(&order_for(&addr, 1.0))));
    let t1 = nth_auth(&m, 1);
    grant(&m, &srv, &t1, 600_000);
    m.wait_received("first order", |v| v["event"] == "new-order");

    // The connection drops; the relay reconnects by itself and logs the address in again as
    // soon as the new hello says so, with no order pending.
    m.push(MockOut::Drop);
    ui.wait_for("OB_SOCKET::disconnect");
    ui.wait_for("OB_SOCKET::connected");
    let t2 = nth_auth(&m, 2);
    assert_ne!(t1, t2);
    assert_eq!(srv.address_of(&t2).as_deref(), Some(addr.as_str()));
    assert_eq!(srv.0.lock().unwrap().challenge_count, 2);
    grant(&m, &srv, &t2, 600_000);
    ui.wait_for("OB_SOCKET::auth_ok");
    // The next order needs no further login.
    ui.emit(&encode_event("new-order", Some(&order_for(&addr, 2.0))));
    m.wait_received("order after the reconnect", |v| {
        v["props"]["price"] == json!(2.0)
    });
    assert_eq!(srv.0.lock().unwrap().challenge_count, 2);
    ui.assert_absent(&t1, 100);
    ui.assert_absent(&t2, 100);
    assert!(ui.seen.iter().all(|p| !p.contains(&t1) && !p.contains(&t2)));
}

#[test]
fn a_login_is_renewed_before_it_expires() {
    let (m, srv) = mock_with_auth();
    let timing = AuthTiming {
        min_lifetime_ms: 100,
        ..AuthTiming::default()
    };
    let hub = hub_with(timing, Box::new(TestSigner::new()));
    let ui = start_ui(&m, &hub);
    let addr = test_address(1);
    ui.emit(&encode_event("new-order", Some(&order_for(&addr, 1.0))));
    let t1 = nth_auth(&m, 1);
    let granted = std::time::Instant::now();
    grant(&m, &srv, &t1, 1_000);
    m.wait_received("order", |v| v["event"] == "new-order");
    // 80 % of a one-second lifetime: the second `auth` comes after about 0.8 s, not before 0.6 s.
    let t2 = nth_auth(&m, 2);
    let waited = granted.elapsed();
    assert!(
        waited >= Duration::from_millis(600) && waited < Duration::from_secs(5),
        "{waited:?}"
    );
    assert_eq!(srv.address_of(&t2).as_deref(), Some(addr.as_str()));
    assert_eq!(srv.0.lock().unwrap().challenge_count, 2);
    // Orders keep flowing during the renewal.
    ui.emit(&encode_event("new-order", Some(&order_for(&addr, 9.0))));
    m.wait_received("order during renewal", |v| {
        v["props"]["price"] == json!(9.0)
    });
}

#[test]
fn a_logout_makes_the_relay_forget_its_logins() {
    let (m, srv) = mock_with_auth();
    let hub = default_hub();
    let ui = start_ui(&m, &hub);
    let addr = test_address(1);
    ui.emit(&encode_event("new-order", Some(&order_for(&addr, 1.0))));
    let t1 = nth_auth(&m, 1);
    grant(&m, &srv, &t1, 600_000);
    m.wait_received("first order", |v| v["event"] == "new-order");

    hub.forget_all();
    std::thread::sleep(Duration::from_millis(200));
    // The next order starts from nothing: a new login, and it waits for it.
    ui.emit(&encode_event("new-order", Some(&order_for(&addr, 5.0))));
    let t2 = nth_auth(&m, 2);
    assert_ne!(t1, t2);
    std::thread::sleep(Duration::from_millis(200));
    assert!(m
        .received_json()
        .iter()
        .all(|v| v["props"]["price"] != json!(5.0)));
    grant(&m, &srv, &t2, 600_000);
    m.wait_received("order after the new login", |v| {
        v["props"]["price"] == json!(5.0)
    });
    assert_eq!(srv.0.lock().unwrap().challenge_count, 2);
}

#[test]
fn a_resume_logs_the_known_addresses_in_again_and_no_token_reaches_the_ui() {
    let (m, srv) = mock_with_auth();
    let hub = default_hub();
    let (sink, rx) = collecting_sink();
    let mut mgr = Manager::new(sink, quick_reconnect()).with_auth(hub);
    assert!(mgr
        .apply(ObCmd::Connect {
            gen: 1,
            url: ws_url_of(&m)
        })
        .is_none());
    expect_up(&rx);
    let addr = test_address(1);
    mgr.apply(ObCmd::Send {
        name: "new-order".into(),
        payload: Some(order_for(&addr, 1.0)),
    });
    let t1 = nth_auth(&m, 1);
    grant(&m, &srv, &t1, 600_000);
    m.wait_received("order", |v| v["event"] == "new-order");

    // The machine woke up: a new client replaces the old one and logs the address in again.
    assert!(mgr.apply(ObCmd::Resume).is_none());
    let t2 = nth_auth(&m, 2);
    assert_ne!(t1, t2);
    assert_eq!(srv.address_of(&t2).as_deref(), Some(addr.as_str()));
    grant(&m, &srv, &t2, 600_000);
    mgr.apply(ObCmd::Send {
        name: "new-order".into(),
        payload: Some(order_for(&addr, 4.0)),
    });
    m.wait_received("order after resume", |v| v["props"]["price"] == json!(4.0));
    assert_eq!(srv.0.lock().unwrap().challenge_count, 2);

    // Every event the UI side got, token-free; `auth_ok` was relayed.
    std::thread::sleep(Duration::from_millis(200));
    let mut all = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        all.push(format!("{ev:?}"));
    }
    assert!(
        all.iter().any(|e| e.contains("OB_SOCKET::auth_ok")),
        "{all:?}"
    );
    assert!(
        all.iter().all(|e| !e.contains(&t1) && !e.contains(&t2)),
        "{all:?}"
    );
    mgr.apply(ObCmd::Stop);
}

#[test]
fn a_token_the_server_echoes_is_stripped_before_the_ui() {
    let (m, srv) = mock_with_auth();
    let hub = default_hub();
    let mut ui = start_ui(&m, &hub);
    let addr = test_address(1);
    ui.emit(&encode_event("new-order", Some(&order_for(&addr, 1.0))));
    let t1 = nth_auth(&m, 1);
    // A server that put the token in its confirmation.
    m.send(
        &json!({"event": "auth_ok", "address": addr, "token": t1, "sessionToken": t1,
                "expiresAt": crate::obauth::wall_ms() + 600_000})
        .to_string(),
    );
    let ok = ui.wait_for("OB_SOCKET::auth_ok");
    assert!(!ok.contains(&t1), "{ok}");
    m.wait_received("order", |v| v["event"] == "new-order");
    let _ = srv;
}

/// Against a real orderbook server with the auth routes (`TL_OB_URL=ws://127.0.0.1:3001`, the
/// `auth` branch of tl-orderbook-server): the relay logs a test key's address in by itself, the
/// server answers `auth_ok`, and the order is accepted and then cancelled. Run with
/// `cargo test --locked -- --ignored real_orderbook_server_login`.
#[test]
#[ignore = "needs a running tl-orderbook-server with /auth; set TL_OB_URL"]
fn real_orderbook_server_login_round_trip() {
    let base = std::env::var("TL_OB_URL").expect("TL_OB_URL");
    let hub = default_hub();
    let h = socketio::start_with_auth(
        Box::new(FakeNode),
        fast(),
        ObPolicy::new(vec![base.clone()]),
        quick(),
        Some(hub),
    )
    .unwrap();
    let mut ui = Ui {
        h,
        sid: String::new(),
        seen: Vec::new(),
    };
    ui.new_session();
    ui.emit(&connect_packet(&format!(
        "{}/ws",
        base.trim_end_matches('/')
    )));
    let hello = ui.wait_for("OB_SOCKET::connected");
    assert!(hello.contains("\"authRequired\":true"), "{hello}");
    let addr = test_address(1);
    let order = json!({"keypair": {"address": addr, "pubkey": "02aa"}, "network": "LTCTEST",
        "type": "SPOT", "isLimitOrder": true, "action": "BUY", "marketName": "TLTC/USDTt",
        "props": {"id_for_sale": 4, "id_desired": 5, "amount": 1, "price": 1}});
    ui.emit(&encode_event("new-order", Some(&order)));
    let ok = ui.wait_for("OB_SOCKET::auth_ok");
    assert!(ok.contains(&addr.to_ascii_lowercase()), "{ok}");
    // The order is accepted, not refused for want of a login.
    let saved = ui.wait_for("OB_SOCKET::order:saved");
    let uuid = match parse_server_packet(&saved) {
        ServerPacket::Event(_, Some(p)) => p["orderUuid"]
            .as_str()
            .or_else(|| p["orderUUID"].as_str())
            .expect("an order uuid")
            .to_string(),
        other => panic!("{other:?}"),
    };
    ui.emit(&encode_event(
        "close-order",
        Some(&json!({"orderUUID": uuid, "id_for_sale": 4, "id_desired": 5, "network": "LTCTEST"})),
    ));
    ui.assert_absent("Authentication required", 1_500);
    ui.emit(r#"42["ob-sockets-disconnect"]"#);
    ui.wait_for("OB_SOCKET::disconnect");
}
