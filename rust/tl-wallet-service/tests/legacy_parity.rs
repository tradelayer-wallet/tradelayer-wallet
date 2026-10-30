//! Parity of the preserved selection/fee arithmetic against the pinned legacy functions.
//! `scripts/legacy-vectors.json` is produced by `node scripts/compare-legacy.cjs --write` from
//! tx-builder.service.ts blob 2b11ba8ed36dce681cc11b5777fc2041efb62f21 (baseline 7ddba36).
mod common;
use common::*;
use serde_json::Value;
use tl_wallet_service::txbuilder::*;

fn vectors() -> Value {
    let text = include_str!("../scripts/legacy-vectors.json");
    serde_json::from_str(text).unwrap()
}

#[test]
fn oracle_is_pinned() {
    let v = vectors();
    assert_eq!(
        v["oracle"]["blob"],
        "2b11ba8ed36dce681cc11b5777fc2041efb62f21"
    );
    assert_eq!(
        v["oracle"]["baseline_commit"],
        "7ddba36ca06538510e6460df0ddece8a71fcb547"
    );
    assert_eq!(v["fee_per_input_sat"].as_u64().unwrap(), FEE_PER_INPUT_SAT);
}

fn utxos(v: &Value) -> Vec<Utxo> {
    v["utxos_sat"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, a)| utxo(i as u8 + 1, 0, a.as_u64().unwrap()))
        .collect()
}

/// Recipient-pays path == legacy `getEnoughInputs` (no change in behaviour).
#[test]
fn recipient_pays_selection_matches_getenoughinputs() {
    for c in vectors()["cases"].as_array().unwrap() {
        let us = utxos(c);
        let amount = c["amount_sat"].as_u64().unwrap();
        let legacy_n = c["legacy_get_enough_inputs"]["count"].as_u64().unwrap() as usize;
        let legacy_fee = c["legacy_get_enough_inputs"]["fee_sat"].as_u64().unwrap();
        let req = PaymentRequest {
            amount: Some(sat(amount)),
            has_payload: false,
            min_out: sat(3_600),
            supplied: &us,
            wallet: &[],
        };
        match plan_payment(&req) {
            Ok(p) => {
                assert_eq!(p.inputs.len(), legacy_n, "{c}");
                assert_eq!(p.fee.sat(), legacy_fee, "{c}");
                assert!(p.check_conservation());
            }
            // legacy would have clamped or under-funded here: the repaired code refuses
            Err(e) => assert!(
                matches!(
                    e,
                    PlanError::AmountTooSmallForFee | PlanError::InsufficientFunds
                ),
                "{c}: {e}"
            ),
        }
    }
}

/// Sender-pays path vs legacy `getEnoughInputs2`: never selects more, and the legacy
/// over-selection of one input is the only permitted difference.
#[test]
fn sender_pays_selection_vs_getenoughinputs2() {
    let mut differs = 0;
    for c in vectors()["cases"].as_array().unwrap() {
        let us = utxos(c);
        let amount = c["amount_sat"].as_u64().unwrap();
        let legacy_n = c["legacy_get_enough_inputs2"]["count"].as_u64().unwrap() as usize;
        let req = PaymentRequest {
            amount: Some(sat(amount)),
            has_payload: true,
            min_out: sat(3_600),
            supplied: &us,
            wallet: &[],
        };
        if let Ok(p) = plan_payment(&req) {
            assert!(p.inputs.len() <= legacy_n, "{c}");
            assert!(legacy_n - p.inputs.len() <= 1, "{c}");
            if p.inputs.len() != legacy_n {
                differs += 1;
            }
            assert!(p.check_conservation());
        }
    }
    println!("cases where the repaired selection is one input shorter: {differs}");
}
