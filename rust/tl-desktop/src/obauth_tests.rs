use super::*;
use crate::bip322;
use bitcoin::secp256k1::{Secp256k1, SecretKey};
use bitcoin::{CompressedPublicKey, ScriptBuf};
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::Mutex;
use tl_wallet_core::{Address, Network};

// ------------------------------------------------------------------ helpers

fn secret(n: u8) -> SecretKey {
    SecretKey::from_slice(&[n; 32]).unwrap()
}

/// A native-segwit LTCTEST address of a test key, and the key.
pub(crate) fn test_address(n: u8) -> String {
    let pk = CompressedPublicKey(secret(n).public_key(&Secp256k1::new()));
    Address::for_account_key(Network::LtcTest, &pk)
        .encode()
        .unwrap()
}

/// Signs BIP-322 simple for the test keys `1..=9` (the address must be [`test_address`]).
pub(crate) struct TestSigner {
    pub fail: Mutex<Option<String>>,
    pub calls: Mutex<Vec<(String, String)>>,
}

impl TestSigner {
    pub(crate) fn new() -> TestSigner {
        TestSigner {
            fail: Mutex::new(None),
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl AuthSigner for TestSigner {
    fn sign(&self, network: &str, address: &str, message: &str) -> Result<String, String> {
        self.calls
            .lock()
            .unwrap()
            .push((network.to_string(), address.to_string()));
        if let Some(e) = self.fail.lock().unwrap().clone() {
            return Err(e);
        }
        let net = Network::parse(network).map_err(|_| "unknown network".to_string())?;
        let spk = Address::parse(net, address)
            .map_err(|e| e.to_string())?
            .script_pubkey()
            .to_owned();
        let secp = Secp256k1::new();
        for n in 1..=9u8 {
            let sk = secret(n);
            let pk = CompressedPublicKey(sk.public_key(&secp));
            if ScriptBuf::new_p2wpkh(&pk.wpubkey_hash()) == spk {
                return bip322::sign_simple_wpkh(&spk, message.as_bytes(), &pk, |m| {
                    secp.sign_ecdsa(m, &sk)
                });
            }
        }
        Err("not a test key".into())
    }
}

pub(crate) fn hub_with(timing: AuthTiming, signer: Box<dyn AuthSigner>) -> Arc<AuthHub> {
    let hub = AuthHub::with_timing(timing);
    hub.set_signer(signer);
    hub
}

fn order(addr: &str) -> Value {
    json!({"keypair": {"address": addr, "pubkey": "02aa"}, "network": "LTCTEST",
           "type": "SPOT", "isLimitOrder": true, "props": {"amount": 1}})
}

fn state() -> AuthState {
    AuthState::new(AuthTiming::default(), Vec::new())
}

/// A short rendering of an action list: `login:<addr>`, `auth`, `fwd:<event>`, `fail:<message>`.
fn show(acts: &[Action]) -> Vec<String> {
    acts.iter()
        .map(|a| match a {
            Action::Login { address, .. } => format!("login:{address}"),
            Action::SendAuth { .. } => "auth".into(),
            Action::Forward { name, .. } => format!("fwd:{name}"),
            Action::FailUi { message } => format!("fail:{message}"),
        })
        .collect()
}

fn ticket_of(acts: &[Action]) -> u64 {
    match &acts[0] {
        Action::Login { ticket, .. } => *ticket,
        other => panic!("{other:?}"),
    }
}

fn tok() -> Token {
    Token::new("secret-token-value".into())
}

const WALL: u64 = 1_700_000_000_000;

/// Drive one address through hello, order, login and `auth_ok` at `now`; returns the state.
fn logged_in(addr: &str, now: u64) -> AuthState {
    let mut s = state();
    s.on_hello(now, true);
    let acts = s.handle_ui(now, "new-order".into(), Some(order(addr)));
    let t = ticket_of(&acts);
    let acts = s.on_login_result(now, WALL, t, addr, Ok((tok(), WALL + 600_000)));
    assert_eq!(show(&acts), ["auth"]);
    let acts = s.on_auth_ok(now, WALL, addr, Some(WALL + 600_000));
    assert_eq!(show(&acts), ["fwd:new-order"]);
    s
}

// ------------------------------------------------------------------ the state machine

#[test]
fn events_that_change_nothing_pass_and_teach_the_network() {
    let mut s = state();
    s.on_hello(0, true);
    for name in [
        "orderbook:join",
        "update-orderbook",
        "orderbook:leave",
        "auth",
    ] {
        let a = s.handle_ui(0, name.into(), Some(json!({"network": "LTCTEST"})));
        assert_eq!(show(&a), [format!("fwd:{name}")]);
    }
    // An order without its own network uses the last one the UI named.
    let mut o = order("tltc1qabc");
    o.as_object_mut().unwrap().remove("network");
    let a = s.handle_ui(1, "new-order".into(), Some(o));
    assert!(matches!(&a[0], Action::Login { network, .. } if network == "LTCTEST"));
}

#[test]
fn an_order_before_the_hello_waits_and_is_logged_in_when_the_hello_asks() {
    let mut s = state();
    assert!(show(&s.handle_ui(5, "new-order".into(), Some(order("A")))).is_empty());
    assert_eq!(s.queued(), 1);
    let acts = s.on_hello(10, true);
    assert_eq!(show(&acts), ["login:A"]);
    let t = ticket_of(&acts);
    let acts = s.on_login_result(20, WALL, t, "A", Ok((tok(), WALL + 600_000)));
    assert_eq!(show(&acts), ["auth"]);
    // The order stays queued until the server confirms.
    assert_eq!(s.queued(), 1);
    assert_eq!(
        show(&s.on_auth_ok(30, WALL, "A", Some(WALL + 600_000))),
        ["fwd:new-order"]
    );
    assert_eq!(s.queued(), 0);
    assert!(s.is_logged_in("A", 31));
}

#[test]
fn a_logged_in_address_forwards_at_once_and_a_new_one_logs_in_first() {
    let mut s = logged_in("A", 0);
    let a = s.handle_ui(10, "new-order".into(), Some(order("A")));
    assert_eq!(show(&a), ["fwd:new-order"]);
    let a = s.handle_ui(11, "new-order".into(), Some(order("B")));
    assert_eq!(show(&a), ["login:B"]);
    // Orders keep their order: a ready address behind a waiting one waits too.
    let a = s.handle_ui(12, "new-order".into(), Some(order("A")));
    assert!(show(&a).is_empty());
    let a = s.handle_ui(13, "close-order".into(), Some(json!({"orderUUID": "u"})));
    assert!(show(&a).is_empty());
    assert_eq!(s.queued(), 3);
}

#[test]
fn queued_orders_are_forwarded_in_order_after_the_login() {
    let mut s = state();
    s.on_hello(0, true);
    let a = s.handle_ui(1, "new-order".into(), Some(order("A")));
    let t = ticket_of(&a);
    // A second order for the same address starts no second login.
    let mut second = order("A");
    second["props"]["amount"] = json!(2);
    assert!(show(&s.handle_ui(2, "new-order".into(), Some(second))).is_empty());
    s.on_login_result(3, WALL, t, "A", Ok((tok(), WALL + 600_000)));
    let acts = s.on_auth_ok(4, WALL, "A", Some(WALL + 600_000));
    let amounts: Vec<i64> = acts
        .iter()
        .map(|a| match a {
            Action::Forward { payload, .. } => payload.as_ref().unwrap()["props"]["amount"]
                .as_i64()
                .unwrap(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(amounts, [1, 2]);
}

#[test]
fn a_server_without_auth_gets_everything_unchanged() {
    let mut s = state();
    s.handle_ui(0, "new-order".into(), Some(order("A")));
    let acts = s.on_hello(1, false);
    assert_eq!(show(&acts), ["fwd:new-order"]);
    let a = s.handle_ui(2, "new-order".into(), Some(order("B")));
    assert_eq!(show(&a), ["fwd:new-order"]);
    assert_eq!(s.queued(), 0);
}

#[test]
fn a_failed_login_fails_the_waiting_orders_and_the_address_cools_down() {
    let mut s = state();
    s.on_hello(0, true);
    let t = ticket_of(&s.handle_ui(100, "new-order".into(), Some(order("A"))));
    s.handle_ui(101, "close-order".into(), Some(json!({"orderUUID": "u"})));
    let acts = s.on_login_result(
        200,
        WALL,
        t,
        "A",
        Err("the orderbook is unreachable".into()),
    );
    // One failure per waiting event: the order and the cancel behind it.
    assert_eq!(
        show(&acts),
        ["fail:Orderbook login failed: the orderbook is unreachable"; 2]
    );
    assert_eq!(s.queued(), 0);
    // Within the cooldown the next order fails at once, with no new login.
    let a = s.handle_ui(300, "new-order".into(), Some(order("A")));
    assert_eq!(
        show(&a),
        ["fail:Orderbook login failed: the orderbook is unreachable"]
    );
    // After it, a new attempt is made.
    let cooldown = AuthTiming::default().cooldown_ms;
    s.tick(200 + cooldown);
    let a = s.handle_ui(201 + cooldown, "new-order".into(), Some(order("A")));
    assert_eq!(show(&a), ["login:A"]);
}

#[test]
fn waiting_orders_time_out_and_an_unconfirmed_auth_fails() {
    let t = AuthTiming::default();
    let mut s = state();
    s.on_hello(0, true);
    s.handle_ui(1_000, "new-order".into(), Some(order("A")));
    assert!(s.tick(1_000 + t.queue_timeout_ms - 1).is_empty());
    assert_eq!(
        show(&s.tick(1_000 + t.queue_timeout_ms)),
        ["fail:Orderbook login timed out"]
    );
    // A login that was sent but never confirmed.
    let mut s = state();
    s.on_hello(0, true);
    let tk2 = ticket_of(&s.handle_ui(0, "new-order".into(), Some(order("A"))));
    s.on_login_result(10, WALL, tk2, "A", Ok((tok(), WALL + 600_000)));
    assert!(s.tick(10 + t.auth_ok_timeout_ms - 1).is_empty());
    assert_eq!(
        show(&s.tick(10 + t.auth_ok_timeout_ms)),
        ["fail:Orderbook login failed: the orderbook did not confirm the login"]
    );
    // A worker that never reports.
    let mut s = state();
    s.on_hello(0, true);
    s.handle_ui(0, "new-order".into(), Some(order("A")));
    let acts = s.tick(t.login_timeout_ms);
    // The queue deadline came first (15 s) and the stuck login (20 s) has nobody waiting.
    assert_eq!(show(&acts), ["fail:Orderbook login timed out"]);
    // A late result of an abandoned login is ignored.
    assert!(s
        .on_login_result(t.login_timeout_ms + 1, WALL, 1, "A", Ok((tok(), WALL)))
        .is_empty());
}

#[test]
fn the_queue_and_the_address_table_are_bounded() {
    let mut s = state();
    s.on_hello(0, true);
    let a = s.handle_ui(0, "new-order".into(), Some(order("A")));
    assert_eq!(show(&a), ["login:A"]);
    for _ in 1..MAX_PENDING {
        assert!(show(&s.handle_ui(1, "new-order".into(), Some(order("A")))).is_empty());
    }
    assert_eq!(s.queued(), MAX_PENDING);
    let a = s.handle_ui(2, "new-order".into(), Some(order("A")));
    assert_eq!(
        show(&a),
        ["fail:too many orders are waiting for the orderbook login"]
    );
    // Addresses.
    let mut s = state();
    s.on_hello(0, true);
    for n in 0..MAX_ADDRESSES {
        let a = s.handle_ui(0, "new-order".into(), Some(order(&format!("addr{n}"))));
        assert_eq!(show(&a), [format!("login:addr{n}")]);
    }
    let a = s.handle_ui(0, "new-order".into(), Some(order("one-more")));
    assert_eq!(
        show(&a),
        ["fail:too many trading addresses for one session"]
    );
}

#[test]
fn a_login_is_renewed_at_eighty_percent_of_its_lifetime() {
    // Injected clock: monotonic `now` and wall time are arguments.
    let mut s = state();
    s.on_hello(0, true);
    let t = ticket_of(&s.handle_ui(1_000, "new-order".into(), Some(order("A"))));
    s.on_login_result(1_000, WALL, t, "A", Ok((tok(), WALL + 600_000)));
    s.on_auth_ok(1_100, WALL + 100, "A", Some(WALL + 600_000));
    // lifetime = 599_900 ms from 1_100; renewal at 1_100 + 479_920.
    let renew = 1_100 + 479_920;
    assert!(s.tick(renew - 1).is_empty());
    let acts = s.tick(renew);
    assert_eq!(show(&acts), ["login:A"]);
    // The address stays usable while the new login is made.
    assert!(s.is_logged_in("A", renew + 1));
    assert_eq!(
        show(&s.handle_ui(renew + 1, "new-order".into(), Some(order("A")))),
        ["fwd:new-order"]
    );
    // Not asked twice.
    assert!(s.tick(renew + 5).is_empty());
    let t2 = ticket_of(&acts);
    s.on_login_result(
        renew + 10,
        WALL + 480_000,
        t2,
        "A",
        Ok((tok(), WALL + 1_080_000)),
    );
    s.on_auth_ok(renew + 20, WALL + 480_020, "A", Some(WALL + 1_080_000));
    // Next renewal 80 % of the new lifetime (599_980 ms) later.
    let next = renew + 20 + 479_984;
    assert!(s.tick(next - 1).is_empty());
    assert_eq!(show(&s.tick(next)), ["login:A"]);
}

#[test]
fn a_failed_renewal_keeps_the_login_and_tries_again_after_the_cooldown() {
    let t = AuthTiming::default();
    let mut s = logged_in("A", 0);
    let renew = 600_000 * 80 / 100;
    let acts = s.tick(renew);
    let tk = ticket_of(&acts);
    assert!(s
        .on_login_result(renew + 1, WALL, tk, "A", Err("boom".into()))
        .is_empty());
    assert!(s.is_logged_in("A", renew + 2));
    assert!(s.tick(renew + t.cooldown_ms).is_empty());
    let acts = s.tick(renew + 1 + t.cooldown_ms);
    assert_eq!(show(&acts), ["login:A"]);
    // Past the real expiry nothing renews; the next order logs in again.
    let mut s = logged_in("A", 0);
    let tk = ticket_of(&s.tick(renew));
    s.on_login_result(renew, WALL, tk, "A", Err("down".into()));
    s.tick(600_001);
    assert!(!s.is_logged_in("A", 600_001));
}

#[test]
fn lifetimes_follow_the_server_but_stay_inside_sane_bounds() {
    let t = AuthTiming::default();
    assert_eq!(lifetime_from(Some(WALL + 600_000), WALL, &t), 600_000);
    assert_eq!(lifetime_from(Some(WALL + 120_000), WALL, &t), 120_000);
    // A server clock far ahead cannot delay renewal past the session length.
    assert_eq!(lifetime_from(Some(WALL + 86_400_000), WALL, &t), 600_000);
    // One far behind (an already expired `expiresAt`) cannot make it spin.
    assert_eq!(
        lifetime_from(Some(WALL - 5_000), WALL, &t),
        t.min_lifetime_ms
    );
    assert_eq!(lifetime_from(None, WALL, &t), 600_000);
    assert_eq!(lifetime_from(Some(0), WALL, &t), 600_000);
}

#[test]
fn a_new_connection_keeps_the_addresses_and_logs_them_in_again_at_the_hello() {
    let mut s = logged_in("A", 0);
    s.reset_connection();
    assert!(!s.is_logged_in("A", 1));
    assert_eq!(s.known(), [("A".to_string(), "LTCTEST".to_string())]);
    // Nothing happens before the hello.
    assert!(s.tick(2).is_empty());
    let acts = s.on_hello(3, true);
    assert_eq!(show(&acts), ["login:A"]);
    // A carried-over seed does the same (hand-over to a new client, resume from sleep).
    let mut fresh = AuthState::new(AuthTiming::default(), s.known());
    assert_eq!(show(&fresh.on_hello(0, true)), ["login:A"]);
    let mut none = AuthState::new(AuthTiming::default(), s.known());
    assert!(show(&none.on_hello(0, false)).is_empty());
}

#[test]
fn forget_drops_addresses_and_queued_orders() {
    let mut s = logged_in("A", 0);
    s.handle_ui(1, "new-order".into(), Some(order("B")));
    assert_eq!(s.queued(), 1);
    s.forget();
    assert_eq!(s.queued(), 0);
    assert!(s.known().is_empty());
    assert!(!s.is_logged_in("A", 2));
    // A late result for the forgotten login is ignored.
    assert!(s
        .on_login_result(3, WALL, 2, "B", Ok((tok(), WALL + 1)))
        .is_empty());
    // The address is logged in again by the next order.
    assert_eq!(
        show(&s.handle_ui(4, "new-order".into(), Some(order("A")))),
        ["login:A"]
    );
}

#[test]
fn many_orders_need_every_address_and_close_order_uses_the_active_one() {
    let mut s = state();
    s.on_hello(0, true);
    let acts = s.handle_ui(
        0,
        "many-orders".into(),
        Some(json!({"orders": [order("A"), order("B"), order("A")], "network": "LTCTEST"})),
    );
    assert_eq!(show(&acts), ["login:A", "login:B"]);
    let (ta, tb) = match (&acts[0], &acts[1]) {
        (Action::Login { ticket: a, .. }, Action::Login { ticket: b, .. }) => (*a, *b),
        _ => unreachable!(),
    };
    s.on_login_result(1, WALL, ta, "A", Ok((tok(), WALL + 600_000)));
    assert!(s.on_auth_ok(2, WALL, "A", Some(WALL + 600_000)).is_empty());
    s.on_login_result(3, WALL, tb, "B", Ok((tok(), WALL + 600_000)));
    assert_eq!(
        show(&s.on_auth_ok(4, WALL, "B", Some(WALL + 600_000))),
        ["fwd:many-orders"]
    );
    // The spot UI sends a bare array.
    let acts = s.handle_ui(5, "many-orders".into(), Some(json!([order("A")])));
    assert_eq!(show(&acts), ["fwd:many-orders"]);
    // `close-order` names no address: the active one (the last order's) is already logged in.
    let a = s.handle_ui(
        6,
        "close-order".into(),
        Some(json!({"orderUUID": "u", "network": "LTCTEST"})),
    );
    assert_eq!(show(&a), ["fwd:close-order"]);
    // After the active address loses its login, a cancel waits for a new one.
    s.reset_connection();
    // The new hello logs both known addresses in; a cancel for the active one waits for that.
    assert_eq!(show(&s.on_hello(7, true)), ["login:A", "login:B"]);
    let a = s.handle_ui(8, "close-order".into(), Some(json!({"orderUUID": "u"})));
    assert!(a.is_empty());
    assert_eq!(s.queued(), 1);
}

#[test]
fn an_order_naming_no_address_is_left_to_the_server() {
    let mut s = state();
    s.on_hello(0, true);
    let a = s.handle_ui(
        0,
        "new-order".into(),
        Some(json!({"props": {}, "network": "LTCTEST"})),
    );
    assert_eq!(show(&a), ["fwd:new-order"]);
    let a = s.handle_ui(0, "close-order".into(), Some(json!({"orderUUID": "u"})));
    assert_eq!(show(&a), ["fwd:close-order"]);
    let a = s.handle_ui(0, "new-order".into(), None);
    assert_eq!(show(&a), ["fwd:new-order"]);
}

#[test]
fn unusable_orders_fail_with_a_reason_and_start_no_login() {
    let fresh = || {
        let mut s = state();
        s.on_hello(0, true);
        s
    };
    let mut s = fresh();
    let bad_addr = order("has space");
    let a = s.handle_ui(0, "new-order".into(), Some(bad_addr));
    assert_eq!(
        show(&a),
        ["fail:the order names an invalid trading address"]
    );
    let long = order(&"a".repeat(MAX_ADDRESS_LEN + 1));
    assert_eq!(
        show(&s.handle_ui(0, "new-order".into(), Some(long))).len(),
        1
    );
    let mut no_net = order("A");
    no_net.as_object_mut().unwrap().remove("network");
    let a = fresh().handle_ui(0, "new-order".into(), Some(no_net));
    assert_eq!(show(&a), ["fail:the order names no network"]);
    let mut odd_net = order("A");
    odd_net["network"] = json!("LTC TEST\n");
    let a = s.handle_ui(0, "new-order".into(), Some(odd_net));
    assert_eq!(show(&a), ["fail:the order names an invalid network"]);
    let many: Vec<Value> = (0..9).map(|n| order(&format!("addr{n}"))).collect();
    let a = s.handle_ui(0, "many-orders".into(), Some(json!({ "orders": many })));
    assert_eq!(show(&a), ["fail:too many trading addresses in one request"]);
    assert_eq!(s.queued(), 0);
    assert!(s.known().is_empty());
}

#[test]
fn results_are_matched_by_ticket_and_unsolicited_auth_ok_is_ignored() {
    let mut s = state();
    s.on_hello(0, true);
    let t = ticket_of(&s.handle_ui(0, "new-order".into(), Some(order("A"))));
    assert!(s
        .on_login_result(1, WALL, t + 7, "A", Ok((tok(), WALL + 600_000)))
        .is_empty());
    assert!(s.on_auth_ok(2, WALL, "A", Some(WALL + 600_000)).is_empty());
    assert!(s.on_auth_ok(2, WALL, "Z", None).is_empty());
    assert!(!s.is_logged_in("A", 3));
    // Address comparison ignores case, as bech32 does.
    s.on_login_result(3, WALL, t, "a", Ok((tok(), WALL + 600_000)));
    assert_eq!(show(&s.on_auth_ok(4, WALL, "A", None)), ["fwd:new-order"]);
    assert!(s.is_logged_in("a", 5));
}

#[test]
fn tokens_are_redacted_in_debug_output() {
    let t = tok();
    assert_eq!(format!("{t:?}"), "Token(<redacted>)");
    let a = Action::SendAuth { token: tok() };
    assert!(!format!("{a:?}").contains("secret-token-value"));
    assert_eq!(t.expose(), "secret-token-value");
    let mut v = json!({"event": "auth_ok", "address": "A", "token": "x", "sessionToken": "y"});
    scrub_tokens(&mut v);
    assert_eq!(v, json!({"event": "auth_ok", "address": "A"}));
}

#[test]
fn the_http_origin_is_the_websocket_origin() {
    let u = |s: &str| reqwest::Url::parse(s).unwrap();
    assert_eq!(
        http_base(&u("ws://172.81.181.19:3001/ws")).unwrap(),
        "http://172.81.181.19:3001"
    );
    assert_eq!(
        http_base(&u("wss://ob.example/ws")).unwrap(),
        "https://ob.example"
    );
    assert_eq!(
        http_base(&u("wss://ob.example:8443/")).unwrap(),
        "https://ob.example:8443"
    );
    assert_eq!(
        http_base(&u("ws://[::1]:3001/ws")).unwrap(),
        "http://[::1]:3001"
    );
    assert!(http_base(&u("ftp://ob.example")).is_none());
}

// ------------------------------------------------------------------ a mock HTTP/auth server

pub(crate) struct Req {
    pub method: String,
    pub path: String,
    pub body: String,
}

pub(crate) struct Resp {
    pub status: u16,
    pub body: String,
}

pub(crate) type Handler = Arc<dyn Fn(&Req) -> Resp + Send + Sync>;

fn read_request(stream: &mut TcpStream) -> Option<Req> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next()?.split(' ');
    let (method, path) = (first.next()?.to_string(), first.next()?.to_string());
    let len = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    while buf.len() < head_end + len {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = String::from_utf8_lossy(&buf[head_end..head_end + len]).to_string();
    Some(Req { method, path, body })
}

/// Answer one HTTP request on `stream`.
pub(crate) fn serve_http(mut stream: TcpStream, h: &Handler) {
    let Some(req) = read_request(&mut stream) else {
        return;
    };
    let r = h(&req);
    let text = format!(
        "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        r.status,
        r.body.len(),
        r.body
    );
    let _ = stream.write_all(text.as_bytes());
    let _ = stream.flush();
}

/// A listener that only speaks HTTP.
struct HttpOnly {
    addr: SocketAddr,
}

impl HttpOnly {
    fn start(h: Handler) -> HttpOnly {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            for c in l.incoming().flatten() {
                let h = h.clone();
                std::thread::spawn(move || serve_http(c, &h));
            }
        });
        HttpOnly { addr }
    }

    fn base(&self) -> String {
        format!("http://{}", self.addr)
    }
}

/// `tl-orderbook-server`'s auth routes: challenge with a nonce, verify with BIP-322, a token per
/// verified address. Behaviour knobs let tests break it.
#[derive(Default)]
pub(crate) struct AuthServerState {
    challenges: HashMap<String, String>,
    pub tokens: HashMap<String, String>,
    pub challenge_count: usize,
    pub verify_ok: usize,
    pub lifetime_ms: u64,
    pub fail_verify: Option<(u16, String)>,
    pub fail_challenge: Option<u16>,
    /// The key under which the server answers the token (`token` or `sessionToken`).
    pub token_key: String,
    /// Every request path seen.
    pub log: Vec<String>,
    counter: u64,
}

#[derive(Clone)]
pub(crate) struct AuthServer(pub Arc<Mutex<AuthServerState>>);

impl AuthServer {
    pub(crate) fn new() -> AuthServer {
        AuthServer(Arc::new(Mutex::new(AuthServerState {
            lifetime_ms: 600_000,
            token_key: "token".into(),
            ..AuthServerState::default()
        })))
    }

    pub(crate) fn handler(&self) -> Handler {
        let st = self.0.clone();
        Arc::new(move |req: &Req| {
            let mut s = st.lock().unwrap();
            s.log.push(format!("{} {}", req.method, req.path));
            match (req.method.as_str(), req.path.as_str()) {
                ("GET", "/auth/challenge") => {
                    s.challenge_count += 1;
                    if let Some(code) = s.fail_challenge {
                        return Resp {
                            status: code,
                            body: "{}".into(),
                        };
                    }
                    s.counter += 1;
                    let nonce = format!("{:032x}", s.counter * 7919 + 0xabcdef);
                    let expires = wall_ms() + 120_000;
                    let message = format!(
                        "TradeLayer session authentication\nnonce={nonce}\nexpires={expires}"
                    );
                    s.challenges.insert(nonce.clone(), message.clone());
                    Resp {
                        status: 200,
                        body: json!({"nonce": nonce, "message": message, "expiresAt": expires})
                            .to_string(),
                    }
                }
                ("POST", "/auth/verify") => {
                    let fail = |status: u16, error: &str| Resp {
                        status,
                        body: json!({ "error": error }).to_string(),
                    };
                    let Ok(b) = serde_json::from_str::<Value>(&req.body) else {
                        return fail(400, "bad json");
                    };
                    let (Some(address), Some(message), Some(signature)) = (
                        b["address"].as_str(),
                        b["message"].as_str(),
                        b["signature"].as_str(),
                    ) else {
                        return fail(400, "missing fields");
                    };
                    let Some(nonce) = message.split("nonce=").nth(1).map(|r| {
                        r.chars()
                            .take_while(|c| c.is_ascii_hexdigit())
                            .collect::<String>()
                    }) else {
                        return fail(400, "nonce missing");
                    };
                    if s.challenges.get(&nonce).map(String::as_str) != Some(message) {
                        return fail(400, "invalid or used challenge");
                    }
                    if let Some((code, e)) = s.fail_verify.clone() {
                        return fail(code, &e);
                    }
                    let Ok(addr) = Address::parse(Network::LtcTest, address) else {
                        return fail(400, "bad address");
                    };
                    if bip322::verify_simple(addr.script_pubkey(), message.as_bytes(), signature)
                        .is_err()
                    {
                        return fail(401, "signature invalid");
                    }
                    s.challenges.remove(&nonce);
                    s.verify_ok += 1;
                    let token = format!("tok{:040x}", s.counter * 104_729 + s.verify_ok as u64);
                    s.tokens.insert(token.clone(), address.to_string());
                    let expires = wall_ms() + s.lifetime_ms;
                    let mut body = json!({"expiresAt": expires});
                    body[s.token_key.clone()] = json!(token);
                    Resp {
                        status: 200,
                        body: body.to_string(),
                    }
                }
                _ => Resp {
                    status: 404,
                    body: "{}".into(),
                },
            }
        })
    }

    pub(crate) fn address_of(&self, token: &str) -> Option<String> {
        self.0.lock().unwrap().tokens.get(token).cloned()
    }
}

// ------------------------------------------------------------------ the login worker

fn run_login(base: &str, hub: &Arc<AuthHub>, address: &str) -> Result<(Token, u64), String> {
    let (tx, rx) = mpsc::channel();
    spawn_login(
        hub,
        base.to_string(),
        "LTCTEST".into(),
        address.to_string(),
        9,
        tx,
    )
    .unwrap();
    let done = rx.recv_timeout(Duration::from_secs(20)).unwrap();
    assert_eq!((done.ticket, done.address.as_str()), (9, address));
    done.result
}

#[test]
fn a_login_signs_the_challenge_and_returns_the_token_and_expiry() {
    let srv = AuthServer::new();
    let http = HttpOnly::start(srv.handler());
    let hub = hub_with(AuthTiming::default(), Box::new(TestSigner::new()));
    let addr = test_address(1);
    let (token, expires) = run_login(&http.base(), &hub, &addr).unwrap();
    assert_eq!(
        srv.address_of(token.expose()).as_deref(),
        Some(addr.as_str())
    );
    assert!(expires > wall_ms());
    let s = srv.0.lock().unwrap();
    assert_eq!(s.log, ["GET /auth/challenge", "POST /auth/verify"]);
    assert_eq!((s.challenge_count, s.verify_ok), (1, 1));
}

#[test]
fn the_older_session_token_field_is_accepted() {
    let srv = AuthServer::new();
    srv.0.lock().unwrap().token_key = "sessionToken".into();
    let http = HttpOnly::start(srv.handler());
    let hub = hub_with(AuthTiming::default(), Box::new(TestSigner::new()));
    let (token, _) = run_login(&http.base(), &hub, &test_address(2)).unwrap();
    assert!(srv.address_of(token.expose()).is_some());
}

#[test]
fn every_failure_of_a_login_has_a_plain_reason() {
    let srv = AuthServer::new();
    let http = HttpOnly::start(srv.handler());
    let signer = Arc::new(TestSigner::new());
    struct Shared(Arc<TestSigner>);
    impl AuthSigner for Shared {
        fn sign(&self, n: &str, a: &str, m: &str) -> Result<String, String> {
            self.0.sign(n, a, m)
        }
    }
    let hub = hub_with(AuthTiming::default(), Box::new(Shared(signer.clone())));
    let addr = test_address(3);
    let base = http.base();
    let err = |r: Result<(Token, u64), String>| r.err().unwrap();

    srv.0.lock().unwrap().fail_challenge = Some(502);
    assert_eq!(
        err(run_login(&base, &hub, &addr)),
        "the challenge request failed (HTTP 502)"
    );
    srv.0.lock().unwrap().fail_challenge = None;

    srv.0.lock().unwrap().fail_verify = Some((401, "signature invalid".into()));
    assert_eq!(
        err(run_login(&base, &hub, &addr)),
        "the orderbook refused the login: signature invalid"
    );
    srv.0.lock().unwrap().fail_verify = Some((500, String::new()));
    assert_eq!(
        err(run_login(&base, &hub, &addr)),
        "the orderbook refused the login (HTTP 500)"
    );
    srv.0.lock().unwrap().fail_verify = None;

    *signer.fail.lock().unwrap() = Some("the wallet is locked".into());
    assert_eq!(
        err(run_login(&base, &hub, &addr)),
        "signing failed: the wallet is locked"
    );
    *signer.fail.lock().unwrap() = None;

    // A signer that signs for another address is refused by the server.
    let other = test_address(4);
    let wrong: Handler = {
        let inner = srv.handler();
        Arc::new(move |r: &Req| {
            if r.path == "/auth/verify" {
                let mut v: Value = serde_json::from_str(&r.body).unwrap();
                v["address"] = json!(other);
                return inner(&Req {
                    method: r.method.clone(),
                    path: r.path.clone(),
                    body: v.to_string(),
                });
            }
            inner(r)
        })
    };
    let http2 = HttpOnly::start(wrong);
    assert_eq!(
        err(run_login(&http2.base(), &hub, &addr)),
        "the orderbook refused the login: signature invalid"
    );

    // Nothing listens: unreachable, and the reason names no address.
    let dead = TcpListener::bind("127.0.0.1:0").unwrap();
    let dead_base = format!("http://{}", dead.local_addr().unwrap());
    drop(dead);
    let e = err(run_login(&dead_base, &hub, &addr));
    assert_eq!(e, "the orderbook is unreachable");
    assert!(!e.contains("127.0.0.1"));

    // No signer installed.
    let bare = AuthHub::new();
    assert_eq!(
        err(run_login(&base, &bare, &addr)),
        "signing is not available"
    );
}

#[test]
fn malformed_challenges_are_refused_before_anything_is_signed() {
    let signer = Arc::new(TestSigner::new());
    struct Shared(Arc<TestSigner>);
    impl AuthSigner for Shared {
        fn sign(&self, n: &str, a: &str, m: &str) -> Result<String, String> {
            self.0.sign(n, a, m)
        }
    }
    let hub = hub_with(AuthTiming::default(), Box::new(Shared(signer.clone())));
    let addr = test_address(5);
    for (body, reason) in [
        ("not json".to_string(), "the challenge answer is not JSON"),
        (
            json!({"nonce": "n"}).to_string(),
            "the challenge has no message",
        ),
        (
            json!({"message": "m"}).to_string(),
            "the challenge has no nonce",
        ),
        (
            json!({"nonce": "abc", "message": "no such text"}).to_string(),
            "the challenge is malformed",
        ),
        (
            json!({"nonce": "abc", "message": format!("abc{}", "x".repeat(2000))}).to_string(),
            "the challenge is malformed",
        ),
        (
            json!({"nonce": "abc", "message": "abc\u{0}"}).to_string(),
            "the challenge is malformed",
        ),
    ] {
        let h: Handler = Arc::new(move |_| Resp {
            status: 200,
            body: body.clone(),
        });
        let http = HttpOnly::start(h);
        let e = run_login(&http.base(), &hub, &addr).err().unwrap();
        assert_eq!(e, reason);
    }
    assert!(signer.calls.lock().unwrap().is_empty());
    // A token-less login answer.
    let srv = AuthServer::new();
    let inner = srv.handler();
    let h: Handler = Arc::new(move |r: &Req| {
        let mut resp = inner(r);
        if r.path == "/auth/verify" && resp.status == 200 {
            resp.body = json!({"expiresAt": 1}).to_string();
        }
        resp
    });
    let http = HttpOnly::start(h);
    assert_eq!(
        run_login(&http.base(), &hub, &addr).err().unwrap(),
        "the login answer has no token"
    );
}

#[test]
fn a_server_that_never_answers_times_out_in_five_seconds() {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let hub = hub_with(AuthTiming::default(), Box::new(TestSigner::new()));
    let started = std::time::Instant::now();
    let e = run_login(&base, &hub, &test_address(6)).err().unwrap();
    let took = started.elapsed();
    assert_eq!(e, "the orderbook timed out");
    assert!(
        took >= Duration::from_secs(4) && took < Duration::from_secs(9),
        "{took:?}"
    );
    drop(l);
}

#[test]
fn login_workers_are_bounded() {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let hub = hub_with(AuthTiming::default(), Box::new(TestSigner::new()));
    let (tx, rx) = mpsc::channel();
    // Connections are accepted by the OS backlog and never answered: the workers stay busy.
    for n in 0..MAX_LOGIN_WORKERS {
        spawn_login(
            &hub,
            base.clone(),
            "LTCTEST".into(),
            "A".into(),
            n as u64,
            tx.clone(),
        )
        .unwrap();
    }
    assert_eq!(
        spawn_login(
            &hub,
            base.clone(),
            "LTCTEST".into(),
            "A".into(),
            99,
            tx.clone()
        ),
        Err("too many logins in flight".to_string())
    );
    drop(rx);
    drop(l);
}

#[test]
fn the_hub_counts_logouts() {
    let hub = AuthHub::new();
    assert_eq!(hub.epoch(), 0);
    hub.forget_all();
    hub.forget_all();
    assert_eq!(hub.epoch(), 2);
    assert_eq!(hub.timing(), AuthTiming::default());
}
