mod common;
use common::*;
use serde_json::json;
use tl_wallet_service::amount::AmountError;
use tl_wallet_service::txforms::*;

// ---------------- payload parameters (page build tab) ----------------

#[test]
fn payload_calls_have_the_legacy_method_names_and_parameter_order() {
    let c = payload_call(PayloadKind::Attestation, &[]).unwrap();
    assert_eq!(
        (c.method, c.params.len()),
        ("tl_createpayload_attestation", 0)
    );
    let c = payload_call(PayloadKind::SimpleSend, &["3", "1.5"]).unwrap();
    assert_eq!(c.method, "tl_createpayload_simplesend");
    assert_eq!(c.params, vec![json!(3), json!("1.5")]);
    let c = payload_call(PayloadKind::SendVesting, &["10"]).unwrap();
    assert_eq!(c.params, vec![json!("10")]);
    let c = payload_call(PayloadKind::SendActivation, &["1", "250000", "170000"]).unwrap();
    assert_eq!(c.method, "tl_createpayload_sendactivation");
    assert_eq!(c.params, vec![json!(1), json!(250000), json!(170000)]);
}

#[test]
fn repaired_amount_strings_have_no_exponent_and_ids_are_strict_integers() {
    // legacy: `value.toString()` of the JS number 1e-7 is "1e-7"; `parseFloat("abc")` is NaN -> null
    assert_eq!(
        payload_call(PayloadKind::SendVesting, &["1e-7"]),
        Err(FormError::Amount(AmountError::Malformed))
    );
    assert_eq!(
        payload_call(PayloadKind::SendVesting, &["0.123456789"]),
        Err(FormError::Amount(AmountError::TooManyDecimals))
    );
    assert_eq!(
        payload_call(PayloadKind::SendVesting, &["0.0000001"])
            .unwrap()
            .params,
        vec![json!("0.0000001")]
    );
    assert_eq!(
        payload_call(PayloadKind::SendVesting, &["0.00000001"])
            .unwrap()
            .params,
        vec![json!("0.00000001")]
    );
    for bad in ["abc", "1.5", "-3", "0", "", "4294967296", "1e3", "0x10"] {
        assert!(
            payload_call(PayloadKind::SimpleSend, &[bad, "1"]).is_err(),
            "prop id {bad:?}"
        );
    }
    assert_eq!(
        payload_call(PayloadKind::SimpleSend, &["4294967295", "1"])
            .unwrap()
            .params[0],
        json!(4294967295u32)
    );
    // zero and negative amounts passed `Validators.required`
    assert_eq!(
        payload_call(PayloadKind::SimpleSend, &["3", "0"]),
        Err(FormError::NotPositive)
    );
    assert_eq!(
        payload_call(PayloadKind::SimpleSend, &["3", "-1"]),
        Err(FormError::Amount(AmountError::Negative))
    );
    assert_eq!(
        payload_call(PayloadKind::SimpleSend, &["3"]),
        Err(FormError::FieldCount)
    );
    assert_eq!(
        payload_call(PayloadKind::SendActivation, &["1", "", "5"]),
        Err(FormError::Missing("block"))
    );
}

#[test]
fn amount_text_is_the_js_number_text_in_the_ordinary_range() {
    use tl_wallet_service::amount::Amount;
    for (sat_v, want) in [
        (150_000_000u64, "1.5"),
        (1_000_000_000, "10"),
        (1, "0.00000001"),
        (123_456_789, "1.23456789"),
        (100_000, "0.001"),
    ] {
        assert_eq!(amount_text(Amount::from_sat(sat_v).unwrap()), want);
    }
}

// ---------------- address check + send dialogs ----------------

#[test]
fn address_check_states_and_validateaddress_parsing() {
    assert_eq!(
        parse_validateaddress(Some(&json!({"isvalid": true}))),
        AddressCheck::Valid
    );
    assert_eq!(
        parse_validateaddress(Some(&json!({"isvalid": false}))),
        AddressCheck::Invalid
    );
    // legacy left `isAddressValid` undefined for these (button enabled)
    for v in [
        json!({}),
        json!({"isvalid": "true"}),
        json!(null),
        json!([]),
    ] {
        assert_eq!(
            parse_validateaddress(Some(&v)),
            AddressCheck::Invalid,
            "{v}"
        );
    }
    assert_eq!(parse_validateaddress(None), AddressCheck::Invalid);
    assert_eq!(AddressCheck::Valid.edited(), AddressCheck::Unchecked);
    assert!(AddressCheck::Pending.legacy_blocks_button());
    assert!(AddressCheck::Invalid.legacy_blocks_button());
    assert!(!AddressCheck::Unchecked.legacy_blocks_button()); // legacy built with an unchecked recipient
    assert!(!AddressCheck::Unchecked.allows_build());
    assert!(!AddressCheck::Pending.allows_build());
    assert!(AddressCheck::Valid.allows_build());
}

#[test]
fn send_requests_have_the_legacy_trade_data_shapes() {
    let v = AddressCheck::Valid;
    let ltc = send_request(
        "mFrom",
        "mTo",
        v,
        &SendTx::Ltc {
            amount: "0.5".into(),
        },
    )
    .unwrap();
    assert_eq!(ltc["txType"], "SEND_LTC");
    assert_eq!(ltc["fromAddress"], "mFrom");
    assert_eq!(ltc["toAddress"], "mTo");
    assert_eq!(ltc["amount"].as_f64(), Some(0.5));
    assert!(ltc.get("propId").is_none());
    let t = send_request(
        "mFrom",
        "mTo",
        v,
        &SendTx::Token {
            amount: "2".into(),
            prop_id: "7".into(),
        },
    )
    .unwrap();
    assert_eq!(t["txType"], "SEND_TOKEN");
    assert_eq!(t["propId"], 7);
    let s = send_request("mFrom", "mTo", v, &SendTx::Vesting { amount: "3".into() }).unwrap();
    assert_eq!(s["txType"], "SEND_VESTING");
    let a = send_request(
        "mFrom",
        "mTo",
        v,
        &SendTx::Activation {
            feature_id: "2".into(),
            block: "300".into(),
            min_client_version: "1".into(),
        },
    )
    .unwrap();
    assert_eq!(a["txType"], "SEND_ACTIVATION");
    assert_eq!(
        (
            a["featureid"].as_u64(),
            a["block"].as_u64(),
            a["minclientversion"].as_u64()
        ),
        (Some(2), Some(300), Some(1))
    );
    assert!(a.get("amount").is_none());
}

#[test]
fn repaired_send_requires_a_positive_recipient_check() {
    let tx = SendTx::Ltc { amount: "1".into() };
    for st in [
        AddressCheck::Unchecked,
        AddressCheck::Pending,
        AddressCheck::Invalid,
    ] {
        assert_eq!(
            send_request("a", "b", st, &tx),
            Err(FormError::AddressNotValidated),
            "{st:?}"
        );
    }
    assert_eq!(
        send_request("", "b", AddressCheck::Valid, &tx),
        Err(FormError::Missing("sender"))
    );
    assert_eq!(
        send_request("a", " ", AddressCheck::Valid, &tx),
        Err(FormError::Missing("toAddress"))
    );
    assert!(send_request(
        "a",
        "b",
        AddressCheck::Valid,
        &SendTx::Ltc { amount: "0".into() }
    )
    .is_err());
    assert!(send_request(
        "a",
        "b",
        AddressCheck::Valid,
        &SendTx::Ltc {
            amount: "NaN".into()
        }
    )
    .is_err());
    assert!(send_request(
        "a",
        "b",
        AddressCheck::Valid,
        &SendTx::Token {
            amount: "1".into(),
            prop_id: "".into()
        }
    )
    .is_err());
}

// ---------------- withdraw ----------------

fn w(to_check: AddressCheck, prop: i64, amount: &str, max: u64) -> Result<WithdrawTx, FormError> {
    withdraw_request("mFrom", "mTo", to_check, prop, amount, sat(max))
}

#[test]
fn withdraw_ltc_and_token_requests() {
    assert_eq!(
        w(AddressCheck::Valid, -1, "0.5", 100_000_000).unwrap(),
        WithdrawTx::Ltc {
            from: "mFrom".into(),
            to: "mTo".into(),
            amount: sat(50_000_000)
        }
    );
    let t = w(AddressCheck::Valid, 7, "2.25", 500_000_000).unwrap();
    match t {
        WithdrawTx::Token { payload_call, .. } => {
            assert_eq!(payload_call.method, "tl_createpayload_simplesend");
            assert_eq!(payload_call.params, vec![json!(7), json!("2.25")]);
        }
        other => panic!("{other:?}"),
    }
    // limits: minimum 0.001, maximum the balance (inclusive)
    assert!(w(AddressCheck::Valid, -1, "0.001", 100_000_000).is_ok());
    assert_eq!(
        w(AddressCheck::Valid, -1, "0.00099999", 100_000_000),
        Err(FormError::BelowMinimum)
    );
    assert!(w(AddressCheck::Valid, -1, "1", 100_000_000).is_ok());
    assert_eq!(
        w(AddressCheck::Valid, -1, "1.00000001", 100_000_000),
        Err(FormError::AboveMaximum)
    );
    assert_eq!(
        withdraw_request("x", "x", AddressCheck::Valid, -1, "1", sat(100_000_000)),
        Err(FormError::SameAddress)
    );
    assert_eq!(
        w(AddressCheck::Valid, 0, "1", 100_000_000),
        Err(FormError::NotAnId("propId"))
    );
    assert_eq!(
        w(AddressCheck::Valid, -2, "1", 100_000_000),
        Err(FormError::NotAnId("propId"))
    );
}

#[test]
fn repaired_withdraw_recipient_is_validated_and_the_amount_has_no_exponent() {
    // the dialog's `validateAddress` body is commented out: isAddressValid stayed null forever
    for st in [
        AddressCheck::Unchecked,
        AddressCheck::Pending,
        AddressCheck::Invalid,
    ] {
        assert_eq!(
            w(st, -1, "1", 100_000_000),
            Err(FormError::AddressNotValidated)
        );
    }
    // legacy: `(0.0000001).toString()` = "1e-7" went to tl_createpayload_simplesend
    assert_eq!(
        w(AddressCheck::Valid, 7, "1e-7", 500_000_000),
        Err(FormError::Amount(AmountError::Malformed))
    );
    assert_eq!(
        w(AddressCheck::Valid, 7, "0.00099999", 500_000_000),
        Err(FormError::BelowMinimum)
    );
}

#[test]
fn withdraw_max_is_confirmed_ltc_or_the_token_balance() {
    let toks = [(7, sat(300)), (9, sat(5))];
    assert_eq!(withdraw_max(-1, sat(42), &toks).sat(), 42);
    assert_eq!(withdraw_max(7, sat(42), &toks).sat(), 300);
    assert_eq!(withdraw_max(8, sat(42), &toks).sat(), 0);
}

// ---------------- multisig ----------------

const K1: &str = G;
const K2: &str = G2;
const K3: &str = G3;

#[test]
fn stepper_matches_the_legacy_n_keys_change() {
    let mut s = Stepper::default();
    assert_eq!((s.n_required, s.n_all), (2, 2));
    s.required_up(); // 2 < 2 is false
    assert_eq!(s.n_required, 2);
    s.required_down(); // not below 2
    assert_eq!(s.n_required, 2);
    for _ in 0..10 {
        s.all_up();
    }
    assert_eq!(s.n_all, 7);
    assert!(!s.all_up());
    for _ in 0..10 {
        s.required_up();
    }
    assert_eq!(s.n_required, 7);
    s.all_down();
    assert_eq!((s.n_required, s.n_all), (6, 6)); // required clamped to the key count
    while s.all_down() {}
    assert_eq!((s.n_required, s.n_all), (2, 2));
    assert!(s.invariant());
}

#[test]
fn stepper_invariant_over_every_action_sequence_of_length_six() {
    fn walk(s: Stepper, depth: u32) {
        assert!(s.invariant(), "{s:?}");
        if depth == 0 {
            return;
        }
        for op in 0..4 {
            let mut n = s;
            match op {
                0 => n.required_up(),
                1 => n.required_down(),
                2 => {
                    n.all_up();
                }
                _ => {
                    n.all_down();
                }
            }
            walk(n, depth - 1);
        }
    }
    walk(Stepper::default(), 9);
}

#[test]
fn multisig_form_builds_the_addmultisigaddress_call() {
    let mut f = MultisigForm::new(Some(K1.to_string()));
    assert_eq!(f.slots.len(), 2);
    assert!(f.legacy_button_disabled());
    f.set_type(0, KeyType::Hot).unwrap();
    assert_eq!(f.slots[0].pubkey, K1);
    f.set_type(1, KeyType::Airgap).unwrap();
    f.set_pubkey(1, &K2.to_uppercase()).unwrap();
    assert!(!f.legacy_button_disabled());
    f.add_key();
    f.set_type(2, KeyType::Hardware).unwrap();
    f.set_pubkey(2, K3).unwrap();
    f.stepper.required_up();
    let call = f.create_call().unwrap();
    assert_eq!(call.method, "addmultisigaddress");
    assert_eq!(call.params, vec![json!(3), json!([K1, K2, K3])]); // lower-cased, in slot order
    f.remove_key();
    assert_eq!(f.slots.len(), 2);
    assert_eq!(f.stepper.n_required, 2);
    assert_eq!(f.create_call().unwrap().params[0], json!(2));
}

#[test]
fn multisig_rejects_a_second_hot_key_and_missing_hot_key() {
    let mut f = MultisigForm::new(Some(K1.to_string()));
    f.set_type(0, KeyType::Hot).unwrap();
    assert_eq!(
        f.set_type(1, KeyType::Hot),
        Err(MultisigError::SecondHotKey)
    );
    assert_eq!(
        f.set_type(0, KeyType::Hot),
        Err(MultisigError::SecondHotKey)
    ); // as legacy
    assert_eq!(
        f.set_type(9, KeyType::Airgap),
        Err(MultisigError::NoSuchSlot)
    );
    assert_eq!(f.set_pubkey(0, K2), Err(MultisigError::PubkeyNotEditable)); // HOT is fixed
    let mut g = MultisigForm::new(None);
    assert_eq!(
        g.set_type(0, KeyType::Hot),
        Err(MultisigError::NoHotKeyAvailable)
    );
    assert_eq!(g.set_pubkey(0, K2), Err(MultisigError::PubkeyNotEditable)); // no type yet
}

#[test]
fn repaired_multisig_type_change_clears_the_old_key() {
    // legacy: HOT -> SERVER kept the hot pubkey (changeKeyType only reset it for AIRGAP)
    let mut f = MultisigForm::new(Some(K1.to_string()));
    f.set_type(0, KeyType::Hot).unwrap();
    f.set_type(0, KeyType::Server).unwrap();
    assert_eq!(f.slots[0].pubkey, "");
    f.set_type(0, KeyType::Hot).unwrap(); // the HOT slot is free again
    assert_eq!(f.slots[0].pubkey, K1);
    f.set_type(0, KeyType::Airgap).unwrap();
    assert_eq!(f.slots[0].pubkey, "");
}

#[test]
fn repaired_multisig_pubkeys_are_validated_and_distinct() {
    let mut f = MultisigForm::new(None);
    for ty in [KeyType::Airgap, KeyType::Hardware] {
        f.set_type(0, ty).unwrap();
    }
    f.set_type(1, KeyType::Server).unwrap();
    f.set_pubkey(0, K1).unwrap();
    f.set_pubkey(1, "zz").unwrap();
    assert!(!f.legacy_button_disabled()); // legacy: any non-empty text was accepted
    assert_eq!(f.create_call().unwrap_err(), MultisigError::BadPubkey(1));
    // 33 bytes of hex that are not a curve point (x = 5 has no y on secp256k1? use x = 0)
    f.set_pubkey(1, &format!("02{}", "00".repeat(32))).unwrap();
    assert_eq!(f.create_call().unwrap_err(), MultisigError::BadPubkey(1));
    // uncompressed key
    let unc = "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
    f.set_pubkey(1, unc).unwrap();
    assert_eq!(f.create_call().unwrap_err(), MultisigError::BadPubkey(1));
    // duplicates (case-insensitive)
    f.set_pubkey(1, &K1.to_uppercase()).unwrap();
    assert_eq!(f.create_call().unwrap_err(), MultisigError::DuplicatePubkey);
    f.set_pubkey(1, K2).unwrap();
    assert!(f.create_call().is_ok());
    assert!(is_compressed_pubkey(K3));
    assert!(!is_compressed_pubkey(""));
}

// ---------------- sign tab ----------------

#[test]
fn raw_tx_input_is_checked() {
    assert!(check_raw_tx("0200000000").is_ok());
    assert!(check_raw_tx("  02ab ").is_ok());
    assert_eq!(check_raw_tx(""), Err(FormError::BadHex));
    assert_eq!(check_raw_tx("abc"), Err(FormError::BadHex));
    assert_eq!(check_raw_tx("zz"), Err(FormError::BadHex));
    assert_eq!(
        check_raw_tx(&"00".repeat(MAX_RAW_TX_HEX / 2 + 1)),
        Err(FormError::TooLarge)
    );
}

#[test]
fn vins_come_from_decoderawtransaction() {
    let t1 = txid(1);
    let t2 = txid(2).to_uppercase();
    let d = json!({"vin": [{"txid": t1, "vout": 0, "scriptSig": {}}, {"txid": t2, "vout": 3}]});
    let v = vins_from_decoded(&d).unwrap();
    assert_eq!(v.len(), 2);
    assert_eq!((v[0].txid.as_str(), v[0].vout), (t1.as_str(), 0));
    assert_eq!((v[1].txid.as_str(), v[1].vout), (txid(2).as_str(), 3));
    for bad in [
        json!({}),
        json!({"vin": []}),
        json!({"vin": "x"}),
        json!({"vin": [{"vout": 1}]}),
        json!({"vin": [{"txid": "ab", "vout": 1}]}),
        json!({"vin": [{"txid": t1, "vout": -1}]}),
        json!({"vin": [{"txid": t1, "vout": 4294967296u64}]}),
        json!({"vin": [{"txid": t1}]}),
    ] {
        assert_eq!(vins_from_decoded(&bad), Err(FormError::Decode), "{bad}");
    }
}

#[test]
fn repaired_coinbase_input_is_not_a_signable_vin() {
    // legacy produced `{txid: undefined, vout: undefined}`
    let d = json!({"vin": [{"coinbase": "03aabbcc", "sequence": 4294967295u64}]});
    assert_eq!(vins_from_decoded(&d), Err(FormError::Coinbase));
}

#[test]
fn detailed_view_needs_every_field_and_a_nonzero_amount() {
    let row = DetailVin {
        txid: txid(1),
        vout: Some(0),
        redeem_script: "52".into(),
        script_pub_key: "a914".into(),
        amount: Some(sat(1)),
    };
    assert!(detail_complete(std::slice::from_ref(&row)));
    assert!(!detail_complete(&[]));
    let mut r = row.clone();
    r.vout = None;
    assert!(!detail_complete(&[row.clone(), r]));
    let mut r = row.clone();
    r.amount = Some(sat(0)); // JS: 0 is falsy
    assert!(!detail_complete(&[r]));
    let mut r = row.clone();
    r.redeem_script.clear();
    assert!(!detail_complete(&[r]));
    let mut r = row;
    r.vout = Some(0); // vout 0 is accepted, as `vout || vout === 0`
    assert!(detail_complete(&[r]));
}
