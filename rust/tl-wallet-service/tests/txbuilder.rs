mod common;
use common::*;
use tl_wallet_service::amount::{Amount, AmountError, MAX_MONEY};
use tl_wallet_service::txbuilder::*;

const MIN: u64 = 3_600; // 0.000036, the node's reference output

fn pay<'a>(
    amount: Option<u64>,
    payload: bool,
    supplied: &'a [Utxo],
    wallet: &'a [Utxo],
) -> PaymentRequest<'a> {
    PaymentRequest {
        amount: amount.map(sat),
        has_payload: payload,
        min_out: sat(MIN),
        supplied,
        wallet,
    }
}

// ---- vectors shared with lean/TlWalletService/TxBuilder.lean ----

#[test]
fn vector_a_recipient_pays_fee() {
    let w = [
        utxo(1, 0, 5_000_000),
        utxo(2, 0, 50_000_000),
        utxo(3, 0, 20_000_000),
    ];
    let p = plan_payment(&pay(Some(10_000_000), false, &[], &w)).unwrap();
    assert_eq!(p.inputs.len(), 1);
    assert_eq!(p.inputs[0].amount.sat(), 50_000_000);
    assert_eq!(p.fee.sat(), 60_000);
    assert_eq!(p.to_amount.sat(), 9_940_000);
    assert_eq!(p.change.sat(), 40_000_000);
    assert!(p.check_conservation());
}

#[test]
fn vector_b_payload_sender_pays_fee() {
    let w = [utxo(1, 0, 50_000), utxo(2, 0, 100_000)];
    let p = plan_payment(&pay(None, true, &[], &w)).unwrap();
    assert_eq!(p.inputs.len(), 1);
    assert_eq!(p.fee.sat(), 60_000);
    assert_eq!(p.to_amount.sat(), 3_600);
    assert_eq!(p.change.sat(), 36_400);
    assert!(p.check_conservation());
}

#[test]
fn vector_c_instant_trade() {
    let commits = [utxo(9, 0, 3_600), utxo(9, 1, 3_600)];
    let w = [utxo(1, 0, 1_000_000)];
    let p = plan_instant_trade(&InstantTradeRequest {
        amount: sat(0),
        min_out: sat(MIN),
        commit_utxos: &commits,
        wallet: &w,
    })
    .unwrap();
    assert_eq!(p.inputs.len(), 3);
    assert_eq!(p.fee.sat(), 180_000);
    assert_eq!(p.seller_amount.sat(), 3_600);
    assert_eq!(p.buyer_change.sat(), 823_600);
    assert!(p.check_conservation());
}

// ---- preserved behaviours ----

#[test]
fn supplied_inputs_come_first_then_wallet_largest_first() {
    let supplied = [utxo(7, 0, 2_000_000)];
    let w = [utxo(1, 0, 1_000_000), utxo(2, 0, 9_000_000)];
    let order = candidate_order(&supplied, &w);
    let amts: Vec<u64> = order.iter().map(|u| u.amount.sat()).collect();
    assert_eq!(amts, vec![2_000_000, 9_000_000, 1_000_000]);
}

#[test]
fn below_minimum_without_payload_is_rejected() {
    let w = [utxo(1, 0, 1_000_000)];
    let e = plan_payment(&pay(Some(1_000), false, &[], &w)).unwrap_err();
    assert_eq!(e, PlanError::BelowMinimum { min: sat(MIN) });
    assert!(e.to_string().starts_with("Minimum amount is: 0.00003600"));
}

#[test]
fn undefined_amount_without_payload_is_not_a_minimum_error() {
    // JS: `minAmount > undefined` is false. amount = min, which cannot cover the fee.
    let w = [utxo(1, 0, 1_000_000)];
    assert_eq!(
        plan_payment(&pay(None, false, &[], &w)).unwrap_err(),
        PlanError::AmountTooSmallForFee
    );
}

#[test]
fn no_inputs_is_an_error() {
    assert_eq!(
        plan_payment(&pay(Some(100_000), false, &[], &[])).unwrap_err(),
        PlanError::NoInputs
    );
}

#[test]
fn insufficient_funds() {
    let w = [utxo(1, 0, 50_000)];
    assert_eq!(
        plan_payment(&pay(Some(100_000), false, &[], &w)).unwrap_err(),
        PlanError::InsufficientFunds
    );
    assert_eq!(
        plan_payment(&pay(None, true, &[], &w)).unwrap_err(),
        PlanError::InsufficientFunds
    );
}

// ---- repaired defects ----

#[test]
fn repaired_payload_tx_does_not_charge_fee_twice() {
    // amount > min + fee with a payload: legacy gave the recipient amount-fee AND deducted the
    // fee from change, so the miner got 2*fee.
    let w = [utxo(1, 0, 10_000_000)];
    let p = plan_payment(&pay(Some(1_000_000), true, &[], &w)).unwrap();
    assert_eq!(p.to_amount.sat(), 1_000_000);
    assert_eq!(p.fee.sat(), 60_000);
    assert_eq!(p.change.sat(), 10_000_000 - 1_000_000 - 60_000);
    assert!(p.check_conservation());
}

#[test]
fn repaired_negative_change_is_an_error_not_a_silent_drop() {
    // inputs cover amount but not amount+fee, with a payload: legacy dropped the (negative)
    // change output and sent an under-funded fee.
    let w = [utxo(1, 0, 3_600 + 50_000)];
    assert_eq!(
        plan_payment(&pay(None, true, &[], &w)).unwrap_err(),
        PlanError::InsufficientFunds
    );
}

#[test]
fn repaired_amount_below_fee_is_not_clamped() {
    // legacy: toAmount = max(min, amount - fee) -> silently under-paid the fee.
    let w = [utxo(1, 0, 1_000_000)];
    assert_eq!(
        plan_payment(&pay(Some(50_000), false, &[], &w)).unwrap_err(),
        PlanError::AmountTooSmallForFee
    );
}

#[test]
fn repaired_duplicate_outpoints_counted_once() {
    let a = utxo(1, 0, 1_000_000);
    let supplied = [a.clone()];
    let w = [a.clone(), utxo(2, 0, 900_000)];
    let order = candidate_order(&supplied, &w);
    assert_eq!(order.len(), 2);
    let p = plan_payment(&pay(Some(1_500_000), false, &supplied, &w)).unwrap();
    let mut ops: Vec<_> = p.inputs.iter().map(|u| (u.txid.clone(), u.vout)).collect();
    ops.sort();
    ops.dedup();
    assert_eq!(ops.len(), p.inputs.len());
    assert!(p.check_conservation());
}

#[test]
fn repaired_commit_utxos_are_mandatory() {
    // The first commit UTXO alone covers the target; legacy dropped the second one.
    let commits = [utxo(9, 0, 1_000_000), utxo(9, 1, 3_600)];
    let p = plan_instant_trade(&InstantTradeRequest {
        amount: sat(0),
        min_out: sat(MIN),
        commit_utxos: &commits,
        wallet: &[utxo(1, 0, 5_000_000)],
    })
    .unwrap();
    assert_eq!(p.inputs.len(), 2);
    assert!(p.inputs.iter().any(|u| u.txid == txid(9) && u.vout == 1));
    assert_eq!(p.fee.sat(), 120_000);
    assert_eq!(p.seller_amount.sat(), 3_600);
    assert_eq!(p.buyer_change.sat(), 880_000);
    assert!(p.check_conservation());
}

#[test]
fn repaired_no_extra_input_selected() {
    // legacy getEnoughInputs2 priced one input too many and pulled in a second input.
    let w = [utxo(1, 0, 100_000), utxo(2, 0, 90_000)];
    let p = plan_payment(&pay(None, true, &[], &w)).unwrap();
    assert_eq!(p.inputs.len(), 1);
}

#[test]
fn repaired_equal_from_and_to_addresses_merge() {
    let outs = merged_outputs(&[
        ("addr".to_string(), sat(3_600)),
        ("addr".to_string(), sat(36_400)),
        ("zero".to_string(), sat(0)),
    ])
    .unwrap();
    assert_eq!(outs, vec![("addr".to_string(), sat(40_000))]);
}

#[test]
fn instant_trade_raises_buyer_output_to_minimum() {
    // spare below min: buyer change is clamped to min and the fee equation still balances.
    let commits = [utxo(9, 0, 100_000)];
    let p = plan_instant_trade(&InstantTradeRequest {
        amount: sat(30_000),
        min_out: sat(MIN),
        commit_utxos: &commits,
        wallet: &[],
    })
    .unwrap();
    // inputs 100_000 - seller 30_000 - fee 60_000 = 10_000 > 3_600
    assert_eq!(p.buyer_change.sat(), 10_000);
    assert!(p.check_conservation());
    let tight = [utxo(9, 0, 30_000 + 60_000 + 3_600)];
    let p = plan_instant_trade(&InstantTradeRequest {
        amount: sat(30_000),
        min_out: sat(MIN),
        commit_utxos: &tight,
        wallet: &[],
    })
    .unwrap();
    assert_eq!(p.buyer_change.sat(), 3_600);
    assert!(p.check_conservation());
    let short = [utxo(9, 0, 30_000 + 60_000 + 3_599)];
    assert_eq!(
        plan_instant_trade(&InstantTradeRequest {
            amount: sat(30_000),
            min_out: sat(MIN),
            commit_utxos: &short,
            wallet: &[],
        })
        .unwrap_err(),
        PlanError::InsufficientFunds
    );
}

#[test]
fn too_many_inputs_is_bounded() {
    let w: Vec<Utxo> = (0..150u32).map(|i| utxo(1, i, 1_000)).collect();
    assert_eq!(
        plan_payment(&pay(Some(10_000_000), false, &[], &w)).unwrap_err(),
        PlanError::TooManyInputs
    );
}

#[test]
fn conservation_over_a_grid() {
    // Property sweep: every successful plan conserves value exactly and respects the fee bound.
    let mut ok = 0;
    for total in [70_000u64, 100_000, 1_000_000, 123_456_789] {
        for amount in [
            None,
            Some(3_600),
            Some(100_000),
            Some(900_000),
            Some(50_000_000),
        ] {
            for payload in [false, true] {
                let w = [utxo(1, 0, total), utxo(2, 0, total / 3 + 1)];
                if let Ok(p) = plan_payment(&pay(amount, payload, &[], &w)) {
                    ok += 1;
                    assert!(p.check_conservation());
                    assert!(p.fee.sat() <= FEE_PER_INPUT_SAT * p.inputs.len() as u64);
                    assert!(p.to_amount.sat() >= MIN);
                }
            }
        }
    }
    assert!(ok > 10);
}

// ---- amounts ----

#[test]
fn amount_parsing_and_bounds() {
    assert_eq!(Amount::parse_coin("0.0006").unwrap().sat(), 60_000);
    assert_eq!(Amount::parse_coin("12").unwrap().sat(), 1_200_000_000);
    assert_eq!(Amount::parse_coin(".5").unwrap().sat(), 50_000_000);
    assert_eq!(
        Amount::parse_coin("0.000000001"),
        Err(AmountError::TooManyDecimals)
    );
    assert_eq!(Amount::parse_coin("-1"), Err(AmountError::Negative));
    assert_eq!(Amount::parse_coin("1e-5"), Err(AmountError::Malformed));
    assert_eq!(Amount::parse_coin(""), Err(AmountError::Malformed));
    assert_eq!(
        Amount::parse_coin("84000000.00000001"),
        Err(AmountError::OutOfRange)
    );
    assert_eq!(
        Amount::from_sat(MAX_MONEY).unwrap().checked_add(sat(1)),
        Err(AmountError::OutOfRange)
    );
    assert_eq!(sat(1).checked_sub(sat(2)), Err(AmountError::Underflow));
    assert_eq!(Amount::from_coin_f64(f64::NAN), Err(AmountError::NotFinite));
    assert_eq!(Amount::from_coin_f64(-0.1), Err(AmountError::Negative));
    assert_eq!(Amount::from_coin_f64(0.000036).unwrap().sat(), 3_600);
    assert_eq!(sat(3_600).to_coin_string(), "0.00003600");
}

#[test]
fn json_number_round_trip() {
    for s in [
        1u64,
        3_600,
        60_000,
        123_456_789,
        99_999_999,
        100_000_001,
        8_399_999_999_999_999,
    ] {
        let v = sat(s).to_json_number();
        let back = Amount::from_coin_f64(v.as_f64().unwrap()).unwrap();
        assert_eq!(back.sat(), s);
    }
}
