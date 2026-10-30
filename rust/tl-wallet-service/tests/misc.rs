mod common;
use common::*;
use tl_wallet_service::bridge::*;
use tl_wallet_service::gate::*;
use tl_wallet_service::market::*;
use tl_wallet_service::nodecfg::*;
use tl_wallet_service::swap::types::SessionId;

const TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

// ---------------- nodecfg ----------------

#[test]
fn conf_render_and_parse_round_trip() {
    let c = validate_new_config("alice", "p@ss=word", 19332, Some("/data")).unwrap();
    let text = render_conf(&c);
    assert_eq!(
        text,
        "rpcuser=alice\nrpcpassword=p@ss=word\nrpcport=19332\ntxindex=1"
    );
    let m = parse_conf(&text);
    assert_eq!(m["rpcpassword"], "p@ss=word");
    assert_eq!(m["txindex"], "1");
}

#[test]
fn parse_conf_skips_comments_blank_and_cr() {
    let m = parse_conf("# c\r\nrpcuser=u\r\n\r\nnovalue=\r\n=nokey\r\nrpcpassword=p\r\n");
    assert_eq!(m.len(), 2);
    assert_eq!(m["rpcuser"], "u");
    assert_eq!(m["rpcpassword"], "p");
}

#[test]
fn rpc_endpoint_defaults_are_the_legacy_ports() {
    let m = parse_conf("rpcuser=u\nrpcpassword=p");
    assert_eq!(rpc_endpoint(&m, false).unwrap().port, 8332);
    assert_eq!(rpc_endpoint(&m, true).unwrap().port, 18332);
    assert_eq!(rpc_endpoint(&m, true).unwrap().host, "localhost");
    let m = parse_conf("rpcuser=u\nrpcpassword=p\nrpcport=99999");
    assert_eq!(rpc_endpoint(&m, true), Err(CfgError::BadPort));
    let m = parse_conf("rpcuser=u\nrpcpassword=p\nrpchost=example.org");
    assert_eq!(rpc_endpoint(&m, true), Err(CfgError::HostNotAllowed));
    assert_eq!(
        rpc_endpoint(&parse_conf("rpcpassword=p"), true),
        Err(CfgError::Missing("rpcuser"))
    );
}

#[test]
fn launch_args_match_legacy_order_and_have_no_shell() {
    let o = LaunchOptions {
        testnet: true,
        startclean: true,
        reindex: true,
        datadir: Some("/data dir/ltc".into()),
    };
    assert_eq!(
        launch_args(&o).unwrap(),
        [
            "-txindex=1",
            "-printtoconsole=0",
            "-testnet=1",
            "-startclean=1",
            "-reindex=1",
            "-datadir=/data dir/ltc"
        ]
    );
    let o = LaunchOptions {
        testnet: false,
        startclean: false,
        reindex: false,
        datadir: None,
    };
    assert_eq!(
        launch_args(&o).unwrap(),
        ["-txindex=1", "-printtoconsole=0"]
    );
    for bad in [
        "/x\" -rpcallowip=0.0.0.0/0 \"",
        "/a/../b",
        "a\nb",
        "",
        "/it's",
    ] {
        let o = LaunchOptions {
            testnet: false,
            startclean: false,
            reindex: false,
            datadir: Some(bad.into()),
        };
        assert_eq!(launch_args(&o), Err(CfgError::BadPath), "{bad:?}");
    }
    assert_eq!(is_testnet("LTCTEST"), Ok(true));
    assert_eq!(is_testnet("LTC"), Ok(false));
    assert_eq!(is_testnet("XTEST"), Err(CfgError::BadNetwork));
}

#[test]
fn endpoint_validation() {
    let allow = vec!["ob.example".to_string()];
    assert_eq!(
        validate_endpoint("https://ob.example/", &allow)
            .unwrap()
            .url,
        "https://ob.example"
    );
    assert_eq!(
        validate_endpoint("https://OB.example:8443/x", &allow)
            .unwrap()
            .host,
        "ob.example"
    );
    assert!(validate_endpoint("http://localhost:3000", &allow).is_ok());
    assert!(validate_endpoint("http://[::1]:3000", &allow).is_ok());
    for bad in [
        "http://ob.example",
        "https://other.example",
        "https://ob.example.evil.example",
        "https://ob.example@evil.example",
        "https://ob.example#x",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "https://ob.example/a b",
        "https:///path",
    ] {
        assert!(validate_endpoint(bad, &allow).is_err(), "{bad}");
    }
}

// ---------------- bridge ----------------

fn gate() -> Gate {
    Gate::new(GateConfig {
        port: 1986,
        token: SessionToken::from_hex(TOKEN).unwrap(),
        allowed_origins: vec!["file://".into()],
        methods: MethodAllowlist::wallet_default(),
    })
}

fn meta(token: Option<&'static str>, origin: Option<&'static str>) -> RequestMeta<'static> {
    RequestMeta {
        peer_is_loopback: true,
        host: Some("localhost:1986"),
        origin,
        token,
    }
}

fn sid(s: &str) -> SessionId {
    SessionId::parse(s).unwrap()
}

#[test]
fn repaired_socket_handshake_is_gated() {
    let mut b = Bridge::new(gate(), vec!["ob.example".into()]);
    // legacy: any page, any origin ("*"), could connect and become the wallet socket
    assert_eq!(
        b.wallet_connect(1, &meta(None, Some("file://"))),
        Err(Deny::MissingToken)
    );
    assert_eq!(
        b.wallet_connect(2, &meta(Some(TOKEN), Some("https://evil.example"))),
        Err(Deny::ForbiddenOrigin)
    );
    assert_eq!(
        b.from_wallet(1, "new-order", 10),
        Decision::Drop("not the authenticated wallet connection")
    );
    assert_eq!(
        b.wallet_connect(3, &meta(Some(TOKEN), Some("file://"))),
        Ok(())
    );
    // a later unauthenticated connection cannot displace it
    assert!(b.wallet_connect(4, &meta(None, None)).is_err());
    assert_eq!(
        b.connect_ob(3, "https://ob.example").unwrap().host,
        "ob.example"
    );
    assert!(matches!(
        b.from_wallet(3, "new-order", 10),
        Decision::Forward(_)
    ));
    assert_eq!(
        b.from_wallet(4, "new-order", 10),
        Decision::Drop("not the authenticated wallet connection")
    );
}

#[test]
fn bridge_connect_ob_validates_url_and_connection() {
    let mut b = Bridge::new(gate(), vec!["ob.example".into()]);
    b.wallet_connect(1, &meta(Some(TOKEN), None)).unwrap();
    assert!(b.connect_ob(1, "https://evil.example").is_err());
    assert!(b.connect_ob(9, "https://ob.example").is_err()); // not the wallet connection
    assert!(b.connect_ob(1, "https://ob.example").is_ok());
    b.wallet_disconnect(1);
    assert_eq!(
        b.from_wallet(1, "new-order", 1),
        Decision::Drop("not the authenticated wallet connection")
    );
}

#[test]
fn bridge_event_allowlists_and_swap_channels() {
    let mut b = Bridge::new(gate(), vec!["ob.example".into()]);
    b.wallet_connect(1, &meta(Some(TOKEN), None)).unwrap();
    assert_eq!(
        b.from_wallet(1, "new-order", 1),
        Decision::Drop("orderbook not connected")
    );
    b.connect_ob(1, "https://ob.example").unwrap();
    for e in [
        "update-orderbook",
        "new-order",
        "close-order",
        "many-orders",
    ] {
        assert_eq!(b.from_wallet(1, e, 100), Decision::Forward(e.into()));
    }
    for e in ["order:saved", "admin", "ob-sockets-connect", "x::swap", ""] {
        assert!(matches!(b.from_wallet(1, e, 1), Decision::Drop(_)), "{e}");
    }
    assert_eq!(
        b.from_wallet(1, "new-order", MAX_EVENT_BYTES + 1),
        Decision::Drop("payload too large")
    );
    // outbound swap frames only for the orderbook socket's own id
    b.set_ob_socket_id(sid("obSock1"));
    assert_eq!(
        b.from_wallet(1, "obSock1::swap", 10),
        Decision::Forward("obSock1::swap".into())
    );
    assert!(matches!(
        b.from_wallet(1, "other::swap", 10),
        Decision::Drop(_)
    ));
    // inbound
    for e in OB_TO_WALLET {
        assert_eq!(
            b.from_orderbook(e, 10),
            Decision::Forward(format!("OB_SOCKET::{e}"))
        );
    }
    assert!(matches!(
        b.from_orderbook("peerSock::swap", 10),
        Decision::Drop(_)
    ));
    assert!(b.register_peer(sid("peerSock")));
    assert_eq!(
        b.from_orderbook("peerSock::swap", 10),
        Decision::Forward("peerSock::swap".into())
    );
    assert!(matches!(
        b.from_orderbook("peerSock::swap", MAX_EVENT_BYTES + 1),
        Decision::Drop(_)
    ));
    assert!(matches!(b.from_orderbook("shell", 10), Decision::Drop(_)));
    b.unregister_peer(&sid("peerSock"));
    assert!(matches!(
        b.from_orderbook("peerSock::swap", 10),
        Decision::Drop(_)
    ));
    // bounded peer set
    for i in 0..MAX_PEERS {
        assert!(b.register_peer(sid(&format!("p{i}"))));
    }
    assert!(!b.register_peer(sid("one-too-many")));
    b.disconnect_ob();
    assert!(matches!(
        b.from_wallet(1, "new-order", 1),
        Decision::Drop(_)
    ));
}

// ---------------- market ----------------

fn bo(price: u64, amount: u64) -> BookOrder {
    BookOrder {
        price: sat(price),
        amount: sat(amount),
    }
}

#[test]
fn aggregate_groups_by_third_decimal_and_rounds_display_to_four() {
    // 1.2345 and 1.2349 share the 1.234 bucket; 1.235 is its own
    let lv = aggregate(&[bo(123_450_000, 5), bo(123_490_000, 7), bo(123_500_000, 1)]).unwrap();
    assert_eq!(lv.len(), 2);
    assert_eq!((lv[0].price.sat(), lv[0].amount.sat()), (123_450_000, 12));
    assert_eq!((lv[1].price.sat(), lv[1].amount.sat()), (123_500_000, 1));
    // display price: first order's price rounded half-up to 4 decimals
    let lv = aggregate(&[bo(123_456_789, 1)]).unwrap();
    assert_eq!(lv[0].price.sat(), 123_460_000);
    let lv = aggregate(&[bo(123_454_999, 1)]).unwrap();
    assert_eq!(lv[0].price.sat(), 123_450_000);
    // sub-0.001 prices: two equal prices share a level (legacy compared rounded vs raw)
    let lv = aggregate(&[bo(99_000, 1), bo(99_000, 2)]).unwrap();
    assert_eq!(lv.len(), 1);
    assert_eq!(lv[0].amount.sat(), 3);
    // overflow is an error, not a wrap
    assert!(aggregate(&[
        bo(100_000_000, 8_000_000_000_000_000),
        bo(100_000_000, 8_000_000_000_000_000)
    ])
    .is_err());
}

#[test]
fn depth_sides_take_nine_levels() {
    let levels: Vec<Level> = (1..=12u64)
        .map(|i| Level {
            price: sat(i * 100_000),
            amount: sat(1),
        })
        .collect();
    let buys = buy_side(levels.clone());
    assert_eq!(buys.len(), 9);
    assert_eq!(buys[0].price.sat(), 1_200_000); // best bid first
    assert_eq!(buys[8].price.sat(), 400_000);
    let sells = sell_side(levels);
    assert_eq!(sells.len(), 9);
    assert_eq!(sells[0].price.sat(), 900_000); // descending, ending at the best ask
    assert_eq!(sells[8].price.sat(), 100_000);
    assert_eq!(best_ask(&sells, sat(100_000_000)).sat(), 100_000);
    assert_eq!(best_ask(&[], sat(100_000_000)).sat(), 100_000_000);
}

#[test]
fn spot_trade_price_rounding_and_fallbacks() {
    assert_eq!(
        spot_trade_price(sat(200_000_000), sat(100_000_000)).sat(),
        200_000_000
    );
    assert_eq!(
        spot_trade_price(sat(100_000_000), sat(300_000_000)).sat(),
        33_333_300
    );
    assert_eq!(spot_trade_price(sat(5), sat(0)).sat(), 100_000_000); // JS Infinity -> 1
    assert_eq!(spot_trade_price(sat(0), sat(5)).sat(), 100_000_000); // 0 || 1
}

#[test]
fn history_side_and_balances() {
    assert_eq!(history_side("a", "a", "b"), Some(TradeSide::Buy));
    assert_eq!(history_side("b", "a", "b"), Some(TradeSide::Sell));
    assert_eq!(history_side("c", "a", "b"), None);
    assert_eq!(history_side("", "", "b"), None);
    let mut u1 = utxo(1, 0, 1_000);
    u1.confirmations = 1;
    let mut u2 = utxo(2, 0, 250);
    u2.confirmations = 0;
    let (c, un) = coin_balance(&[u1, u2], 1).unwrap();
    assert_eq!((c.sat(), un.sat()), (1_000, 250));
}
