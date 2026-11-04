//! Handle lifecycle and the two backends.

use super::*;
use crate::nodewallet::{NodeSlot, SharedConnector, WIF_REFUSED};
use serde_json::{json, Value};
use std::cell::Cell;
use tl_wallet_service::mem::{MemConnector, MemRpc};
use tl_wallet_service::nodecfg::RpcEndpoint;
use tl_wallet_service::service::NodeConnector;

const KAT: &str = include_str!("fespeed_sign_kat.json");
const HOUR: Duration = Duration::from_secs(60 * 60);

fn kat() -> Value {
    serde_json::from_str(KAT).unwrap()
}

fn secp() -> Rc<Secp256k1<All>> {
    Rc::new(Secp256k1::new())
}

fn key_at(n: u32) -> LocalKey {
    let phrase =
        ImportedMnemonic::parse_phrase(kat()["mnemonics"]["m1"].as_str().unwrap()).unwrap();
    LocalKey::derive(
        &secp(),
        Network::LtcTest,
        &phrase.to_seed(),
        &format!("m/49/60/1/0/{n}"),
    )
    .unwrap()
}

/// A table whose clock the test moves.
fn table(cap: usize, ttl: Duration) -> (KeyTable, Rc<Cell<Duration>>) {
    let clock = Rc::new(Cell::new(Duration::ZERO));
    let c = clock.clone();
    (
        KeyTable::with_limits(cap, ttl, Box::new(move || c.get())),
        clock,
    )
}

#[test]
fn a_handle_is_tlk1_and_128_random_bits() {
    let (mut t, _) = table(8, HOUR);
    let h = t.insert(key_at(0)).unwrap();
    let id = h.strip_prefix("tlk1:").unwrap();
    assert_eq!(id.len(), 32);
    assert!(id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    // another table, same key: a different id (the id is random, not derived from the key)
    let (mut t2, _) = table(8, HOUR);
    assert_ne!(t2.insert(key_at(0)).unwrap(), h);
    assert!(t.resolve(&h, Network::LtcTest).is_ok());
}

#[test]
fn the_same_key_keeps_its_handle_and_a_new_key_gets_a_new_one() {
    let (mut t, _) = table(8, HOUR);
    let a = t.insert(key_at(0)).unwrap();
    assert_eq!(t.insert(key_at(0)).unwrap(), a);
    let b = t.insert(key_at(1)).unwrap();
    assert_ne!(a, b);
    assert_eq!(t.len(), 2);
}

#[test]
fn unknown_malformed_and_foreign_network_handles_are_refused() {
    let (mut t, _) = table(8, HOUR);
    let h = t.insert(key_at(0)).unwrap();
    let id = h.strip_prefix("tlk1:").unwrap();
    for bad in [
        "".to_string(),
        "tlk1:".to_string(),
        "tlk1:zz".to_string(),
        format!("tlk1:{}", id.to_uppercase()),
        format!("tlk1:{id}00"),
        format!("tlk2:{id}"),
        id.to_string(),
        "L1aGnV5XrLQ".to_string(),
    ] {
        assert_eq!(
            t.resolve(&bad, Network::LtcTest).unwrap_err(),
            "key handle malformed",
            "{bad:?}"
        );
    }
    let unknown = format!("tlk1:{}", "0".repeat(32));
    assert!(t
        .resolve(&unknown, Network::LtcTest)
        .unwrap_err()
        .contains("unknown key handle"));
    assert!(t
        .resolve(&h, Network::Ltc)
        .unwrap_err()
        .contains("another network"));
    assert!(t
        .resolve(&h, Network::BtcTest)
        .unwrap_err()
        .contains("another network"));
    assert!(t.resolve(&h, Network::LtcTest).is_ok());
}

#[test]
fn a_handle_expires_after_the_idle_time_and_use_keeps_it_alive() {
    let (mut t, clock) = table(8, HOUR);
    let h = t.insert(key_at(0)).unwrap();
    clock.set(HOUR - Duration::from_secs(1));
    assert!(t.resolve(&h, Network::LtcTest).is_ok());
    // used just now: another almost-hour is fine
    clock.set(HOUR * 2 - Duration::from_secs(2));
    assert!(t.resolve(&h, Network::LtcTest).is_ok());
    // idle for the whole time: refused, and the key is gone for good
    clock.set(HOUR * 3 - Duration::from_secs(2));
    assert!(t
        .resolve(&h, Network::LtcTest)
        .unwrap_err()
        .contains("expired"));
    assert!(t
        .resolve(&h, Network::LtcTest)
        .unwrap_err()
        .contains("unknown"));
    assert!(t.is_empty());
}

#[test]
fn expired_keys_leave_the_table_when_another_key_arrives() {
    let (mut t, clock) = table(8, HOUR);
    t.insert(key_at(0)).unwrap();
    t.insert(key_at(1)).unwrap();
    clock.set(HOUR);
    t.insert(key_at(2)).unwrap();
    assert_eq!(t.len(), 1);
}

#[test]
fn the_table_is_bounded_and_drops_the_least_recently_used_key() {
    let (mut t, clock) = table(3, HOUR);
    let h: Vec<String> = (0..3)
        .map(|n| {
            clock.set(Duration::from_secs(n as u64));
            t.insert(key_at(n)).unwrap()
        })
        .collect();
    // touching key 0 makes key 1 the oldest
    clock.set(Duration::from_secs(10));
    t.resolve(&h[0], Network::LtcTest).unwrap();
    clock.set(Duration::from_secs(11));
    let h3 = t.insert(key_at(3)).unwrap();
    assert_eq!(t.len(), 3);
    assert!(t
        .resolve(&h[1], Network::LtcTest)
        .unwrap_err()
        .contains("unknown"));
    for live in [&h[0], &h[2], &h3] {
        assert!(t.resolve(live, Network::LtcTest).is_ok());
    }
    // many more keys never grow it past the bound
    for n in 4..40 {
        t.insert(key_at(n)).unwrap();
        assert!(t.len() <= 3);
    }
}

#[test]
fn clear_forgets_every_handle() {
    let (mut t, _) = table(8, HOUR);
    let hs: Vec<String> = (0..4).map(|n| t.insert(key_at(n)).unwrap()).collect();
    t.clear();
    assert!(t.is_empty());
    for h in hs {
        assert!(t
            .resolve(&h, Network::LtcTest)
            .unwrap_err()
            .contains("unknown"));
    }
}

fn backends() -> (HandleKeys, HandleSigner, SharedKeys, MemRpc) {
    let table = KeyTable::shared();
    let s = secp();
    let mem = MemConnector::default();
    let node = mem.node.clone();
    let slot = NodeSlot::default();
    let ep = RpcEndpoint {
        user: "u".into(),
        password: "p".into(),
        host: "localhost".into(),
        port: 1,
    };
    let client = SharedConnector::new(mem, slot.clone())
        .connect(&ep, true)
        .unwrap();
    // the signer holds only a weak handle to the node client: keep the client alive for the test
    std::mem::forget(client);
    (
        HandleKeys::new(table.clone(), s.clone()),
        HandleSigner::new(NodeWalletSigner::new(slot), table.clone(), s),
        table,
        node,
    )
}

fn phrase(kat: &Value, name: &str) -> String {
    kat["mnemonics"][name].as_str().unwrap().to_string()
}

#[test]
fn key_pair_answers_the_address_the_pubkey_an_empty_privkey_and_a_handle() {
    let kat = kat();
    let (mut keys, _, table, _) = backends();
    let row = &kat["derive"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| {
            r["network"] == "LTCTEST" && r["mnemonic"] == "m1" && r["path"] == "m/49/60/1/0/0"
        })
        .unwrap()["expect"];
    let r = keys
        .key_pair("LTCTEST", &phrase(&kat, "m1"), "m/49/60/1/0/0")
        .unwrap();
    assert_eq!(r["address"], row["address"]);
    assert_eq!(r["pubkey"], row["pubkey"]);
    assert_eq!(r["privkey"], json!(""));
    assert!(r["wif"].as_str().unwrap().starts_with("tlk1:"));
    assert_eq!(r.as_object().unwrap().len(), 4);
    // nothing in the answer is the key, in any encoding
    let text = r.to_string();
    for secret in [
        row["privkey"].as_str().unwrap(),
        row["wif"].as_str().unwrap(),
    ] {
        assert!(!text.contains(secret));
    }
    assert_eq!(table.borrow().len(), 1);
}

#[test]
fn key_pair_refuses_bad_input_without_leaving_a_key_behind() {
    let kat = kat();
    let (mut keys, _, table, _) = backends();
    let good = phrase(&kat, "m1");
    assert!(keys.key_pair("DOGE", &good, "m/49/60/1/0/0").is_err());
    assert!(keys.key_pair("LTCTEST", &good, "m/49/60/x").is_err());
    let words: Vec<&str> = good.split(' ').collect();
    // wrong checksum: the last word is swapped
    let bad_checksum = format!("{} abandon", words[..11].join(" "));
    assert!(keys
        .key_pair("LTCTEST", &bad_checksum, "m/49/60/1/0/0")
        .is_err());
    assert!(keys
        .key_pair("LTCTEST", "abandon abandon", "m/49/60/1/0/0")
        .is_err());
    assert!(table.borrow().is_empty());
    assert!(keys.new_mnemonic("XYZ").is_err());
}

#[test]
fn new_mnemonic_is_twelve_valid_words_and_fresh_each_time() {
    let (mut keys, _, _, _) = backends();
    let a = keys.new_mnemonic("LTC").unwrap();
    let b = keys.new_mnemonic("LTC").unwrap();
    assert_ne!(a, b);
    assert_eq!(a.split(' ').count(), 12);
    assert!(ImportedMnemonic::parse_phrase(&a).is_ok());
}

#[test]
fn logout_through_the_backend_stops_every_handle_from_signing() {
    let kat = kat();
    let (mut keys, mut signer, _, _) = backends();
    let c = &kat["signPsbt"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "native p2wpkh, key A")
        .unwrap()
        .clone();
    let h = keys
        .key_pair("LTCTEST", &phrase(&kat, "m1"), "m/49/60/1/0/0")
        .unwrap()["wif"]
        .as_str()
        .unwrap()
        .to_string();
    let psbt = c["psbtHex"].as_str().unwrap();
    assert!(signer.sign_psbt("LTCTEST", &h, psbt).is_ok());
    keys.clear();
    let e = signer.sign_psbt("LTCTEST", &h, psbt).unwrap_err();
    assert!(e.contains("unknown key handle"), "{e}");
}

#[test]
fn a_handle_signs_exactly_what_fe_speed_signs_with_the_wif() {
    let kat = kat();
    let (mut keys, mut signer, _, node) = backends();
    let wif_of = |k: &mut HandleKeys, name: &str| -> String {
        let key = &kat["keys"][name];
        k.key_pair(
            "LTCTEST",
            &phrase(&kat, key["mnemonic"].as_str().unwrap()),
            key["path"].as_str().unwrap(),
        )
        .unwrap()["wif"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let (ha, hb) = (wif_of(&mut keys, "A"), wif_of(&mut keys, "B"));
    // the swap: the buyer signs the trade PSBT with A, the seller completes it with B
    let first = kat["signPsbt"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "channel input, first signer A")
        .unwrap();
    let second = kat["signPsbt"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "channel input, second signer B")
        .unwrap();
    let r1 = signer
        .sign_psbt("LTCTEST", &ha, first["psbtHex"].as_str().unwrap())
        .unwrap();
    assert_eq!(r1["psbtHex"], first["expect"]["data"]["psbtHex"]);
    assert_eq!(r1["isFinished"], json!(false));
    let r2 = signer
        .sign_psbt("LTCTEST", &hb, r1["psbtHex"].as_str().unwrap())
        .unwrap();
    assert_eq!(r2["finalHex"], second["expect"]["data"]["finalHex"]);
    assert_eq!(r2["isFinished"], json!(true));
    // sign-tx
    let c = kat["signTx"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "single input")
        .unwrap();
    let inputs: Vec<Utxo> = c["inputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| Utxo {
            txid: v["txid"].as_str().unwrap().into(),
            vout: v["vout"].as_u64().unwrap() as u32,
            amount: tl_wallet_service::amount::Amount::from_sat(
                (v["amount"].as_f64().unwrap() * 1e8).round() as u64,
            )
            .unwrap(),
            confirmations: 3,
            script_pub_key: v["scriptPubKey"].as_str().unwrap().into(),
            redeem_script: None,
            pubkey: None,
        })
        .collect();
    let r = signer
        .sign_tx("LTCTEST", c["rawtx"].as_str().unwrap(), &ha, &inputs)
        .unwrap();
    assert_eq!(r["signedHex"], c["expect"]["data"]["signedHex"]);
    // none of it touched the node
    assert_eq!(node.total_calls(), 0);
}

#[test]
fn a_handle_signs_only_on_its_own_network() {
    let kat = kat();
    let (mut keys, mut signer, _, _) = backends();
    let h = keys
        .key_pair("LTCTEST", &phrase(&kat, "m1"), "m/49/60/1/0/0")
        .unwrap()["wif"]
        .as_str()
        .unwrap()
        .to_string();
    let psbt = kat["signPsbt"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "wrong network id")
        .unwrap()["psbtHex"]
        .as_str()
        .unwrap()
        .to_string();
    for n in ["BTC", "LTC", "BTCTEST"] {
        let e = signer.sign_psbt(n, &h, &psbt).unwrap_err();
        assert!(e.contains("another network"), "{n}: {e}");
    }
    assert!(signer.sign_psbt("DOGE", &h, &psbt).is_err());
    assert!(signer.sign_psbt("LTCTEST", &h, &psbt).is_ok());
}

#[test]
fn a_real_wif_is_refused_and_never_reaches_the_node() {
    let kat = kat();
    let (_, mut signer, _, node) = backends();
    let real = kat["keys"]["A"]["wif"].as_str().unwrap().to_string();
    let hex_key = kat["keys"]["A"]["privkey"].as_str().unwrap().to_string();
    let psbt = kat["signPsbt"][0]["psbtHex"].as_str().unwrap().to_string();
    for k in [
        real,
        hex_key,
        "tlk1".into(),
        "tlk".into(),
        " tlk1:00".into(),
    ] {
        assert_eq!(
            signer.sign_psbt("LTCTEST", &k, &psbt).unwrap_err(),
            WIF_REFUSED,
            "{k}"
        );
        assert_eq!(
            signer.sign_tx("LTCTEST", "00", &k, &[]).unwrap_err(),
            WIF_REFUSED,
            "{k}"
        );
    }
    assert_eq!(node.total_calls(), 0);
}

#[test]
fn the_empty_placeholder_goes_to_the_node_wallet_and_a_malformed_handle_does_not() {
    let (_, mut signer, _, node) = backends();
    node.script(
        "walletprocesspsbt",
        json!({"psbt": "cHNidP8BAA==", "complete": false}),
    );
    assert!(signer.sign_psbt("LTCTEST", "", "70736274ff0100").is_ok());
    assert_eq!(node.calls_of("walletprocesspsbt"), 1);
    let e = signer
        .sign_psbt("LTCTEST", "tlk1:short", "70736274ff0100")
        .unwrap_err();
    assert_eq!(e, "key handle malformed");
    assert_eq!(node.calls_of("walletprocesspsbt"), 1);
}
