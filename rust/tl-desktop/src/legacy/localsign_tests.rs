//! Known-answer tests: FE-speed's own `crypto.util.ts` signs synthetic keys (BIP39 test
//! mnemonics) and the Rust signer must reproduce its bytes. Deterministic RFC 6979 signatures make
//! the comparison exact.

use super::*;
use crate::legacy::keyvault::LocalKey;
use tl_wallet_core::keys::ImportedMnemonic;
use tl_wallet_core::Network;
use tl_wallet_service::amount::Amount;

/// Vectors produced by FE-speed's own `crypto.util.ts` (see `scripts/gen-fespeed-sign-kat.cjs`).
const KAT: &str = include_str!("fespeed_sign_kat.json");

fn kat() -> Value {
    serde_json::from_str(KAT).unwrap()
}

fn key(kat: &Value, network: &str, mnemonic: &str, path: &str) -> LocalKey {
    let phrase = kat["mnemonics"][mnemonic].as_str().unwrap();
    let seed = ImportedMnemonic::parse_phrase(phrase).unwrap().to_seed();
    let secp = Secp256k1::new();
    LocalKey::derive(&secp, Network::parse(network).unwrap(), &seed, path).unwrap()
}

fn named_key(kat: &Value, name: &str) -> LocalKey {
    let k = &kat["keys"][name];
    key(
        kat,
        "LTCTEST",
        k["mnemonic"].as_str().unwrap(),
        k["path"].as_str().unwrap(),
    )
}

fn utxo(v: &Value) -> Utxo {
    Utxo {
        txid: v["txid"].as_str().unwrap().to_string(),
        vout: v["vout"].as_u64().unwrap() as u32,
        amount: Amount::from_sat((v["amount"].as_f64().unwrap() * 1e8).round() as u64).unwrap(),
        confirmations: 3,
        script_pub_key: v["scriptPubKey"].as_str().unwrap_or("").to_string(),
        redeem_script: v["redeemScript"].as_str().map(str::to_string),
        pubkey: None,
    }
}

fn case<'a>(kat: &'a Value, list: &str, name: &str) -> &'a Value {
    kat[list]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no vector {name}"))
}

#[test]
fn derivation_matches_fe_speeds_get_key_pair_on_every_network() {
    let kat = kat();
    let rows = kat["derive"].as_array().unwrap();
    assert_eq!(rows.len(), 32);
    for r in rows {
        let k = key(
            &kat,
            r["network"].as_str().unwrap(),
            r["mnemonic"].as_str().unwrap(),
            r["path"].as_str().unwrap(),
        );
        let e = &r["expect"];
        let what = format!("{} {} {}", r["network"], r["mnemonic"], r["path"]);
        assert_eq!(k.address(), e["address"].as_str().unwrap(), "{what}");
        assert_eq!(k.pubkey_hex(), e["pubkey"].as_str().unwrap(), "{what}");
        assert_eq!(k.secret_hex(), e["privkey"].as_str().unwrap(), "{what}");
        assert_eq!(k.wif(), e["wif"].as_str().unwrap(), "{what}");
    }
}

#[test]
fn sign_tx_is_byte_identical_to_fe_speeds_sign_raw_transaction() {
    let kat = kat();
    let secp = Secp256k1::new();
    let cases = kat["signTx"].as_array().unwrap();
    assert!(cases.len() >= 7);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let k = named_key(&kat, c["wif"].as_str().unwrap());
        let inputs: Vec<Utxo> = c["inputs"].as_array().unwrap().iter().map(utxo).collect();
        let got = sign_tx(&secp, &k, c["rawtx"].as_str().unwrap(), &inputs);
        match (c["expect"].get("data"), c["expect"].get("error")) {
            (Some(d), _) => {
                let g = got.unwrap_or_else(|e| panic!("{name}: {e}"));
                assert_eq!(g["signedHex"], d["signedHex"], "{name}");
                assert_eq!(g["isFinished"], d["isFinished"], "{name}");
                assert_eq!(g["isValid"], d["isValid"], "{name}");
            }
            (None, Some(e)) => assert_eq!(got.unwrap_err(), e.as_str().unwrap(), "{name}"),
            _ => panic!("{name}: malformed vector"),
        }
    }
}

#[test]
fn sign_psbt_is_byte_identical_to_fe_speeds_sign_psbt_rawt_tx() {
    let kat = kat();
    let secp = Secp256k1::new();
    let cases = kat["signPsbt"].as_array().unwrap();
    let mut compared = 0;
    for c in cases {
        let name = c["name"].as_str().unwrap();
        if c["network"] != "LTCTEST" {
            continue; // a handle's network is checked before signing (keyvault tests)
        }
        let k = named_key(&kat, c["wif"].as_str().unwrap());
        let got = sign_psbt(&secp, &k, c["psbtHex"].as_str().unwrap());
        match (c["expect"].get("data"), c["expect"].get("error")) {
            (Some(d), _) => {
                let g = got.unwrap_or_else(|e| panic!("{name}: {e}"));
                assert_eq!(g["psbtHex"], d["psbtHex"], "{name}");
                assert_eq!(g["isFinished"], d["isFinished"], "{name}");
                assert_eq!(g.get("finalHex"), d.get("finalHex"), "{name}");
                assert_eq!(g["isValid"], json!(true), "{name}");
            }
            (None, Some(e)) => assert_eq!(got.unwrap_err(), e.as_str().unwrap(), "{name}"),
            _ => panic!("{name}: malformed vector"),
        }
        compared += 1;
    }
    assert!(compared >= 16, "{compared}");
}

#[test]
fn sign_tx_keeps_the_raw_transactions_version_locktime_and_sequences() {
    let kat = kat();
    let secp = Secp256k1::new();
    let k = named_key(&kat, "A");
    let c = case(&kat, "signTx", "single input");
    let mut tx: Transaction = bitcoin::consensus::deserialize(
        &Vec::<u8>::from_hex(c["rawtx"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    tx.version = bitcoin::transaction::Version::ONE;
    tx.lock_time = bitcoin::absolute::LockTime::from_consensus(7);
    tx.input[0].sequence = bitcoin::Sequence(0xffff_fffe);
    let raw = bitcoin::consensus::encode::serialize_hex(&tx);
    let inputs: Vec<Utxo> = c["inputs"].as_array().unwrap().iter().map(utxo).collect();
    let r = sign_tx(&secp, &k, &raw, &inputs).unwrap();
    assert_eq!(r["isFinished"], json!(true));
    let out: Transaction = bitcoin::consensus::deserialize(
        &Vec::<u8>::from_hex(r["signedHex"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(out.version, tx.version);
    assert_eq!(out.lock_time, tx.lock_time);
    assert_eq!(out.input[0].sequence, tx.input[0].sequence);
    assert_eq!(out.output, tx.output);
    assert_eq!(out.input[0].witness.len(), 2);
}

#[test]
fn sign_tx_refuses_what_fe_speed_would_have_signed_into_a_dead_transaction() {
    let kat = kat();
    let secp = Secp256k1::new();
    let k = named_key(&kat, "A");
    let c = case(&kat, "signTx", "single input");
    let raw = c["rawtx"].as_str().unwrap();
    let mut inputs: Vec<Utxo> = c["inputs"].as_array().unwrap().iter().map(utxo).collect();
    // the input pays somebody else's P2SH, or a native P2WPKH FE-speed's P2SH scriptSig cannot spend
    for spk in [
        format!("a914{}87", "11".repeat(20)),
        format!("0014{}", "22".repeat(20)),
    ] {
        inputs[0].script_pub_key = spk;
        assert!(sign_tx(&secp, &k, raw, &inputs)
            .unwrap_err()
            .contains("scriptPubKey"));
    }
    // an input the caller did not list, a malformed multisig script, junk hex
    assert!(sign_tx(&secp, &k, raw, &[])
        .unwrap_err()
        .contains("not among the inputs"));
    inputs[0].script_pub_key.clear();
    inputs[0].redeem_script = Some("5121".into());
    assert!(sign_tx(&secp, &k, raw, &inputs)
        .unwrap_err()
        .contains("multisig"));
    assert!(sign_tx(&secp, &k, "zz", &inputs).is_err());
    assert!(sign_psbt(&secp, &k, "zz").is_err());
    assert!(sign_psbt(&secp, &k, &"00".repeat(MAX_PSBT_HEX_CHARS))
        .unwrap_err()
        .contains("too large"));
}

#[test]
fn sign_psbt_does_not_sign_twice_or_into_a_finalised_input() {
    let kat = kat();
    let secp = Secp256k1::new();
    let a = named_key(&kat, "A");
    let c = case(&kat, "signPsbt", "native p2wpkh, key A");
    let done = c["expect"]["data"]["psbtHex"].as_str().unwrap();
    let mut psbt = Psbt::deserialize(&Vec::<u8>::from_hex(done).unwrap()).unwrap();
    assert_eq!(psbt.inputs[0].partial_sigs.len(), 1);
    assert_eq!(
        sign_psbt(&secp, &a, done).unwrap_err(),
        "No inputs were signed"
    );
    finalize_all(&mut psbt).unwrap();
    let fin = psbt.serialize().to_lower_hex_string();
    assert_eq!(
        sign_psbt(&secp, &a, &fin).unwrap_err(),
        "No inputs were signed"
    );
}
