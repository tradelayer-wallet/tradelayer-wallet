//! Known-answer tests for the ports of FE-speed's local computations.
//!
//! `fespeed_kat.json` holds fixed inputs and the outputs of FE-speed's own TypeScript:
//! `buildTradeLayerPayload` and its helpers (`rpc-proxy.service.ts`, commit 8da87d7) and
//! `computeMultisigNative` (`tx-builder.service.ts`), both from `origin/FE-speed` @ `3f4a67c`.
//! The functions were extracted from the sources unchanged, transpiled with TypeScript 4.7.2 and
//! run under Node 24.19.0 with bitcoinjs-lib 6.0.1 (the version the wallet pins); the outputs
//! were written to the JSON file as they came out.

use serde_json::Value;
use tl_wallet_service::multisig::compute_multisig;
use tl_wallet_service::tlpayload::build_payload;

const KAT: &str = include_str!("fespeed_kat.json");

fn kat() -> Value {
    serde_json::from_str(KAT).unwrap()
}

#[test]
fn payload_encoders_match_the_typescript_output() {
    let k = kat();
    let cases = k["payloads"].as_array().unwrap();
    assert!(cases.len() >= 20);
    for c in cases {
        let method = c["method"].as_str().unwrap();
        let got = build_payload(method, &c["body"]).unwrap();
        match &c["expect"] {
            Value::Null => assert_eq!(got, None, "{method} {}", c["body"]),
            Value::String(s) => {
                assert_eq!(got.as_deref(), Some(s.as_str()), "{method} {}", c["body"])
            }
            other => panic!("unexpected expectation {other}"),
        }
    }
}

#[test]
fn compute_multisig_matches_bitcoinjs() {
    let k = kat();
    let cases = k["multisig"].as_array().unwrap();
    let mut ok_cases = 0;
    for c in cases {
        let got = compute_multisig(c.get("m"), c.get("pubKeys"), c["network"].as_str().unwrap());
        match c["expect"].get("error") {
            Some(e) => assert_eq!(got.unwrap_err(), e.as_str().unwrap(), "{c}"),
            None => {
                ok_cases += 1;
                assert_eq!(got.unwrap(), c["expect"], "{c}");
            }
        }
    }
    // all four networks are covered by an answer, not only by errors
    assert_eq!(ok_cases, 4);
}
