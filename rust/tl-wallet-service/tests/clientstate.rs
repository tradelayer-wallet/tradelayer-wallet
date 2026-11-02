mod common;
use serde_json::json;
use std::cell::RefCell;
use tl_wallet_service::amount::AmountError;
use tl_wallet_service::clientstate::*;

// ---------------- attestation ----------------

#[test]
fn kyc_result_key_has_a_trailing_space() {
    assert!(parse_kyc(&json!({"result: ": "enabled(kyc_0)"})));
    assert!(!parse_kyc(&json!({"result": "enabled(kyc_0)"})));
    assert!(!parse_kyc(&json!({"result: ": "disabled"})));
    assert!(!parse_kyc(&json!(null)));
}

#[test]
fn attestation_book_tracks_pending_and_only_yes_counts() {
    let wallet: Vec<String> = ["a", "b", "a", "c"].iter().map(|s| s.to_string()).collect();
    let mut b = AttestationBook::default();
    assert_eq!(b.unchecked(&wallet), vec!["a", "b", "c"]);
    b.resolve("a", true);
    b.resolve("b", false);
    assert_eq!(b.unchecked(&wallet), vec!["c"]);
    assert!(b.is_attested("a"));
    assert!(!b.is_attested("b"));
    assert!(!b.is_attested("zzz"));
    b.set_pending("b");
    b.set_pending("zzz"); // unknown address: no entry is created
    assert_eq!(b.state("b"), Some(Att::Pending));
    assert_eq!(b.state("zzz"), None);
    assert!(!b.is_attested("b")); // 'PENDING' !== true
    assert_eq!(b.pending(), vec!["b"]);
    b.resolve("b", true);
    assert!(b.is_attested("b") && b.pending().is_empty());
    b.remove_all();
    assert_eq!(b.unchecked(&wallet), vec!["a", "b", "c"]);
}

#[test]
fn repaired_attestation_error_text_uses_the_real_error() {
    // legacy read `error.messagokee`, so the toast said "undefined"
    let t = attestation_error_text("tltc1q", Some("connection refused"));
    assert!(t.contains("connection refused") && t.contains("tltc1q") && !t.contains("undefined"));
    assert!(!attestation_error_text("x", None).contains("undefined"));
    assert!(attestation_error_text("x", Some("")).contains("unknown error"));
}

// ---------------- positions and commits ----------------

#[test]
fn position_is_open_only_for_a_nonzero_size() {
    let p = parse_position(&json!({
        "entry_price": "2.5", "position": "-3.25", "BANKRUPTCY_PRICE": "9",
        "position_margin": "1", "upnl": "0.1"
    }))
    .unwrap()
    .unwrap();
    assert_eq!(p.size_sat, -325_000_000);
    assert_eq!(p.entry_price, "2.5");
    assert_eq!(p.bankruptcy_price, "9");
    assert_eq!(
        parse_position(&json!({"position": 2}))
            .unwrap()
            .unwrap()
            .size_sat,
        200_000_000
    );
    for none in [
        json!({"position": "0"}),
        json!({"position": "0.00000000"}),
        json!({"position": ""}),
        json!({"position": null}),
        json!({}),
    ] {
        assert_eq!(parse_position(&none), Ok(None), "{none}");
    }
}

#[test]
fn repaired_malformed_position_is_an_error_not_nan() {
    assert!(matches!(
        parse_position(&json!({"position": "abc"})),
        Err(StateError::Amount(_))
    ));
    assert_eq!(
        parse_position(&json!({"position": "1e3"})),
        Err(StateError::Amount(AmountError::Malformed))
    );
    assert_eq!(
        parse_position(&json!({"position": [1]})),
        Err(StateError::Malformed("position"))
    );
    assert_eq!(parse_signed("-0.5"), Ok(-50_000_000));
    assert!(parse_signed("--1").is_err());
}

#[test]
fn commits_parse_and_reject_malformed_entries() {
    let d = json!([
        {"amount": "1.5", "propertyId": "3", "block": 120, "channel": "ch", "sender": "s"},
        {"amount": 2, "propertyId": 4, "block": 121, "channel": "ch2", "sender": "s2"}
    ]);
    let v = parse_commits(&d).unwrap();
    assert_eq!(v.len(), 2);
    assert_eq!(
        (v[0].amount.sat(), v[0].property_id, v[0].block),
        (150_000_000, 3, 120)
    );
    assert_eq!((v[1].amount.sat(), v[1].property_id), (200_000_000, 4));
    assert_eq!(parse_commits(&json!([])).unwrap().len(), 0);
    // legacy: NaN amounts / property ids and a non-array result throwing inside `.map`
    assert!(parse_commits(&json!({"a": 1})).is_err());
    let bad = |amount: &str, prop: &str, with_block: bool| {
        let mut o = json!({"amount": amount, "propertyId": prop, "channel": "c", "sender": "s"});
        if with_block {
            o["block"] = json!(1);
        }
        parse_commits(&json!([o]))
    };
    assert!(bad("x", "1", true).is_err());
    assert!(bad("1", "q", true).is_err());
    assert!(bad("1", "1", false).is_err());
    assert!(bad("-1", "1", true).is_err());
    assert!(bad("1", "1", true).is_ok());
}

// ---------------- node reward ----------------

fn ra(a: &str, auto: bool, r: Registration) -> RewardAddress {
    RewardAddress {
        address: a.into(),
        registration: r,
        auto_claim: auto,
    }
}

#[test]
fn registered_list_keeps_the_colon_key_and_pendings() {
    let reg = parse_registered(&json!([{"address:": "a"}, {"address:": "c"}])).unwrap();
    assert_eq!(reg, vec!["a", "c"]);
    assert!(parse_registered(&json!([{"address": "a"}])).is_err());
    assert!(parse_registered(&json!("x")).is_err());
    let mut list = vec![
        ra("a", false, Registration::Unknown),
        ra("b", false, Registration::Pending),
        ra("c", false, Registration::Registered),
    ];
    update_registration(&mut list, &reg, false);
    assert_eq!(list[0].registration, Registration::Registered);
    assert_eq!(list[1].registration, Registration::Pending); // kept
    update_registration(&mut list, &["a".to_string()], true);
    assert_eq!(list[1].registration, Registration::NotRegistered);
    assert_eq!(list[2].registration, Registration::NotRegistered);
    assert_eq!(
        (REWARD_REGISTER_PAYLOAD, REWARD_CLAIM_PAYLOAD),
        ("007900", "007A00")
    );
    assert!(parse_winner(&json!({"result": "true"})));
    assert!(!parse_winner(&json!({"result": true}))); // as legacy: the string 'true'
}

#[test]
fn repaired_claim_round_claims_each_winner_once() {
    let addrs = vec![
        ra("a", true, Registration::Registered),
        ra("b", false, Registration::Registered),
        ra("c", true, Registration::Registered),
    ];
    let checks = RefCell::new(Vec::new());
    let claims = RefCell::new(Vec::new());
    let rep = claim_round(
        &addrs,
        |a| {
            checks.borrow_mut().push(a.to_string());
            Ok(true) // still a winner after the claim: legacy recursed and claimed again
        },
        |a| {
            claims.borrow_mut().push(a.to_string());
            Ok(())
        },
    );
    assert_eq!(rep.claimed, vec!["a", "c"]);
    assert_eq!(*claims.borrow(), vec!["a", "c"]);
    assert_eq!(*checks.borrow(), vec!["a", "c"]); // "b" has no auto-claim
}

#[test]
fn repaired_claim_round_retries_a_failing_check_a_bounded_number_of_times() {
    let addrs = vec![
        ra("a", true, Registration::Registered),
        ra("c", true, Registration::Registered),
    ];
    let calls = RefCell::new(0u32);
    let rep = claim_round(
        &addrs,
        |a| {
            if a == "a" {
                *calls.borrow_mut() += 1;
                Err("node down".into())
            } else {
                Ok(false)
            }
        },
        |_| panic!("no claim expected"),
    );
    assert_eq!(*calls.borrow(), MAX_CHECK_RETRIES + 1);
    assert_eq!(rep.check_failed, vec!["a"]);
    assert_eq!(rep.check_retries, MAX_CHECK_RETRIES);
    assert!(rep.claimed.is_empty());
    // a transient error recovers, a failed claim is reported
    let n = RefCell::new(0);
    let rep = claim_round(
        &addrs[..1],
        |_| {
            *n.borrow_mut() += 1;
            if *n.borrow() < 3 {
                Err("x".into())
            } else {
                Ok(true)
            }
        },
        |_| Err("insufficient fee".into()),
    );
    assert_eq!(rep.claim_failed, vec!["a"]);
    assert_eq!(rep.check_retries, 2);
}

// ---------------- sync state ----------------

#[test]
fn sync_state_follows_blocks_and_core_errors() {
    let mut s = SyncState::default();
    assert!(!s.is_synced());
    s.is_able_to_rpc = true;
    assert!(!s.is_synced()); // no header yet
    s.on_new_block(99, 100);
    assert!(s.is_synced()); // last + 1 >= header
    s.on_new_block(98, 100);
    assert!(!s.is_synced());
    let ev = s.on_new_block(100, 100);
    assert_eq!(
        (ev.source, ev.block, ev.header),
        (BlockSource::Local, 100, 100)
    );
    s.is_core_started = true;
    s.clear();
    assert!(!s.is_synced() && !s.is_core_started && s.last_block == 0);
}

#[test]
fn network_info_emits_only_new_nonzero_blocks() {
    let mut s = SyncState::default();
    assert_eq!(s.on_network_info(&json!({"block": 0})), None);
    assert_eq!(s.on_network_info(&json!({})), None);
    let e = s
        .on_network_info(&json!({"block": 5, "headers": 7}))
        .unwrap();
    assert_eq!((e.source, e.block, e.header), (BlockSource::Api, 5, 7));
    assert_eq!(s.on_network_info(&json!({"block": 5, "headers": 7})), None);
    assert_eq!(s.on_network_info(&json!({"block": 6})).unwrap().header, 0);
}

// ---------------- auth ----------------

#[test]
fn address_list_and_active_key_selection() {
    let k = WalletKeys {
        main: vec!["m1".into()],
        spot: vec!["s1".into(), "s2".into()],
        futures: vec![],
        reward: vec!["r1".into()],
        liquidity: vec!["l1".into()],
    };
    assert_eq!(k.all_addresses(), vec!["m1", "s1", "s2", "r1", "l1"]);
    assert!(k.is_logged_in());
    assert!(!WalletKeys::default().is_logged_in());
    assert_eq!(active_key(Some("s2"), &k.spot), Some("s2"));
    assert_eq!(active_key(Some("gone"), &k.spot), Some("s1")); // stale choice -> first
    assert_eq!(active_key(None, &k.spot), Some("s1"));
    assert_eq!(active_key(None, &k.futures), None);
}

#[test]
fn getaddressesbylabel_outcomes() {
    assert_eq!(
        classify_addresses(Some(-18), None, None),
        AddressesOutcome::CreateWallet
    );
    assert_eq!(
        classify_addresses(Some(-11), None, Some("x")),
        AddressesOutcome::Empty
    );
    let d = json!({"a1": {"purpose": "receive"}, "a2": {}});
    assert_eq!(
        classify_addresses(None, Some(&d), None),
        AddressesOutcome::Addresses(vec!["a1".into(), "a2".into()])
    );
    assert!(matches!(
        classify_addresses(None, None, None),
        AddressesOutcome::Failed(_)
    ));
    assert_eq!(
        classify_addresses(None, Some(&d), Some("boom")),
        AddressesOutcome::Failed("boom".into())
    );
}

#[test]
fn repaired_create_wallet_retry_is_bounded() {
    // legacy recursed forever while the node kept answering -18
    let asks = RefCell::new(0);
    let creates = RefCell::new(0);
    let r = fetch_wallet_addresses(
        || {
            *asks.borrow_mut() += 1;
            AddressesOutcome::CreateWallet
        },
        || {
            *creates.borrow_mut() += 1;
            Ok(())
        },
    );
    assert!(r.is_err());
    assert_eq!((*asks.borrow(), *creates.borrow()), (2, 1));
    // one create fixes it
    let first = RefCell::new(true);
    let r = fetch_wallet_addresses(
        || {
            if first.replace(false) {
                AddressesOutcome::CreateWallet
            } else {
                AddressesOutcome::Addresses(vec!["a".into()])
            }
        },
        || Ok(()),
    );
    assert_eq!(r, Ok(vec!["a".to_string()]));
    assert_eq!(
        fetch_wallet_addresses(|| AddressesOutcome::Empty, || Ok(())),
        Ok(vec![])
    );
    assert!(
        fetch_wallet_addresses(|| AddressesOutcome::CreateWallet, || Err("no".into())).is_err()
    );
}
