//! Channel multisig on descriptor wallets: the signer adds the key-origin hint, the (scripted)
//! node signs only hinted inputs, exactly as a descriptor wallet does.

use super::*;
use bitcoin::bip32::{DerivationPath, Fingerprint};
use bitcoin::ecdsa::Signature;
use bitcoin::secp256k1::{Message, Secp256k1, SecretKey};
use bitcoin::sighash::EcdsaSighashType;
use std::collections::BTreeMap;

const NET: &str = "LTCTEST";
const FP: &str = "3614f2ab";
const KEYPATH: &str = "m/84h/1h/0h/0/7";
/// 2G and 3G: valid compressed points (the KAT keys of `multisig.rs`).
const KEY_A: &str = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const KEY_B: &str = "03f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

#[derive(Default)]
struct State {
    info: BTreeMap<String, Value>,
    /// The key this scripted wallet signs with, if any.
    wallet_key: Option<SecpKey>,
    /// Descriptor wallets sign a script-hash input only when the PSBT carries the key's
    /// derivation; a legacy wallet with the script imported signs without it.
    needs_hint: bool,
    /// `walletprocesspsbt` answers `complete` and finalizes the inputs it signed.
    finalize: bool,
    /// Inputs this scripted wallet refuses to sign.
    skip: Vec<usize>,
    /// Every PSBT `walletprocesspsbt` received (base64).
    seen: Vec<String>,
    calls: Vec<String>,
}

#[derive(Clone, Default)]
struct DescNode(Rc<RefCell<State>>);

fn sig() -> Signature {
    let secp = Secp256k1::new();
    let sk = SecretKey::from_slice(&[7u8; 32]).unwrap();
    Signature {
        signature: secp.sign_ecdsa(&Message::from_digest([1u8; 32]), &sk),
        sighash_type: EcdsaSighashType::All,
    }
}

impl RpcBackend for DescNode {
    fn call(&mut self, method: &str, params: &[Value]) -> CallResult {
        let mut s = self.0.borrow_mut();
        s.calls.push(method.to_string());
        match method {
            "getaddressinfo" => Ok(s
                .info
                .get(params[0].as_str().unwrap_or(""))
                .cloned()
                .unwrap_or(json!({"ismine": false}))),
            "walletprocesspsbt" => {
                let b64 = params[0].as_str().unwrap().to_string();
                s.seen.push(b64.clone());
                let mut psbt = Psbt::deserialize(&b64_decode(&b64).unwrap()).unwrap();
                let Some(key) = s.wallet_key else {
                    return Ok(json!({"psbt": b64, "complete": false}));
                };
                let pk = bitcoin::PublicKey::new(key);
                let mut all = true;
                for (i, pi) in psbt.inputs.iter_mut().enumerate() {
                    let mine = !s.skip.contains(&i)
                        && (pi.bip32_derivation.contains_key(&key)
                            || (!s.needs_hint
                                && [&pi.witness_script, &pi.redeem_script]
                                    .into_iter()
                                    .flatten()
                                    .any(|sc| script_pushes_key(&key.serialize(), sc))));
                    if mine {
                        pi.partial_sigs.insert(pk, sig());
                        if s.finalize {
                            pi.partial_sigs.clear();
                            pi.final_script_witness =
                                Some(bitcoin::Witness::from_slice(&[vec![1u8], vec![2u8]]));
                        }
                    } else {
                        all = false;
                    }
                }
                Ok(json!({
                    "psbt": b64_encode(&psbt.serialize()),
                    "complete": s.finalize && all,
                }))
            }
            "finalizepsbt" => Ok(json!({"hex": "0200final", "complete": true})),
            m => Err(format!("{m}: not scripted")),
        }
    }
}

fn p2sh(fill: u8) -> ScriptBuf {
    ScriptBuf::new_p2sh(&bitcoin::ScriptHash::from_byte_array([fill; 20]))
}

fn address_of(script: &ScriptBuf) -> String {
    Address::from_script(Network::LtcTest, script)
        .unwrap()
        .encode()
        .unwrap()
}

fn key_bytes(hex: &str) -> Vec<u8> {
    hex_to_bytes(hex).unwrap()
}

fn multisig(keys: &[&str]) -> ScriptBuf {
    let mut b = vec![0x50 + keys.len() as u8];
    for k in keys {
        b.push(33);
        b.extend_from_slice(&key_bytes(k));
    }
    b.extend_from_slice(&[0x50 + keys.len() as u8, 0xae]);
    ScriptBuf::from_bytes(b)
}

/// The wallet's own receive address (the handle) and a node that owns it with key `KEY_A`.
/// `origin` controls whether `getaddressinfo` reports fingerprint and path.
fn node_with(origin: bool) -> (DescNode, String) {
    let own = p2sh(0x11);
    let node = DescNode::default();
    let mut info = json!({"ismine": true, "pubkey": KEY_A});
    if origin {
        info["hdmasterfingerprint"] = json!(FP);
        info["hdkeypath"] = json!(KEYPATH);
    }
    {
        let mut s = node.0.borrow_mut();
        s.info.insert(address_of(&own), info);
        s.wallet_key = Some(SecpKey::from_slice(&key_bytes(KEY_A)).unwrap());
        s.needs_hint = true;
        for fill in [0x22u8, 0x33] {
            s.info
                .insert(address_of(&p2sh(fill)), json!({"ismine": false}));
        }
    }
    (node, format!("{NODE_HANDLE_PREFIX}{}", address_of(&own)))
}

fn signer(node: &DescNode) -> (NodeWalletSigner, Shared) {
    let shared: Shared = Rc::new(RefCell::new(Box::new(node.clone())));
    let slot = NodeSlot::default();
    slot.set(&shared);
    (NodeWalletSigner::new(slot), shared)
}

/// One input per `(scriptPubKey, redeem script, witness script)`.
fn psbt_of(inputs: &[(ScriptBuf, Option<ScriptBuf>, Option<ScriptBuf>)]) -> Psbt {
    let tx = bitcoin::Transaction {
        version: bitcoin::transaction::Version::TWO,
        lock_time: bitcoin::absolute::LockTime::ZERO,
        input: (0..inputs.len())
            .map(|i| bitcoin::TxIn {
                previous_output: bitcoin::OutPoint {
                    txid: bitcoin::Txid::from_byte_array([i as u8 + 1; 32]),
                    vout: 0,
                },
                ..Default::default()
            })
            .collect(),
        output: vec![bitcoin::TxOut {
            value: bitcoin::Amount::from_sat(900_000),
            script_pubkey: p2sh(0x99),
        }],
    };
    let mut p = Psbt::from_unsigned_tx(tx).unwrap();
    for (i, (spk, rs, ws)) in inputs.iter().enumerate() {
        p.inputs[i].witness_utxo = Some(bitcoin::TxOut {
            value: bitcoin::Amount::from_sat(1_000_000),
            script_pubkey: spk.clone(),
        });
        p.inputs[i].redeem_script = rs.clone();
        p.inputs[i].witness_script = ws.clone();
    }
    p
}

fn hex_of(p: &Psbt) -> String {
    bytes_to_hex(&p.serialize())
}

fn parse_b64(b64: &str) -> Psbt {
    Psbt::deserialize(&b64_decode(b64).unwrap()).unwrap()
}

fn p2wsh(ws: &ScriptBuf) -> ScriptBuf {
    ScriptBuf::new_p2wsh(&ws.wscript_hash())
}

fn key_a() -> SecpKey {
    SecpKey::from_slice(&key_bytes(KEY_A)).unwrap()
}

#[test]
fn the_hint_goes_on_the_channel_input_with_the_wallet_key_origin_and_nowhere_else() {
    let (node, handle) = node_with(true);
    let (mut s, _keep) = signer(&node);
    let chan = multisig(&[KEY_A, KEY_B]);
    let foreign = multisig(&[KEY_B, KEY_B]);
    let p = psbt_of(&[
        (p2wsh(&chan), None, Some(chan.clone())),
        (p2sh(0x22), None, None),
        (p2wsh(&foreign), None, Some(foreign.clone())),
    ]);
    let r = s.sign_psbt(NET, &handle, &hex_of(&p)).unwrap();

    // what the node received: the entry on input 0 only, with the node's own fingerprint and path
    let seen = parse_b64(&node.0.borrow().seen[0]);
    let want = (
        Fingerprint::from_str(FP).unwrap(),
        DerivationPath::from_str(KEYPATH).unwrap(),
    );
    assert_eq!(seen.inputs[0].bip32_derivation.len(), 1);
    assert_eq!(seen.inputs[0].bip32_derivation[&key_a()], want);
    assert!(seen.inputs[1].bip32_derivation.is_empty());
    assert!(seen.inputs[2].bip32_derivation.is_empty());
    // nothing else of the PSBT changed
    let mut unhinted = seen.clone();
    unhinted.inputs[0].bip32_derivation.clear();
    assert_eq!(unhinted, p);

    // the node signed input 0 with the wallet key, so the reply is valid; the hint is gone from
    // the PSBT handed back and the signature stays
    assert_eq!(r["isValid"], json!(true));
    assert_eq!(r["isFinished"], json!(false));
    let back = Psbt::deserialize(&hex_to_bytes(r["psbtHex"].as_str().unwrap()).unwrap()).unwrap();
    assert!(back.inputs[0].bip32_derivation.is_empty());
    assert!(back.inputs[0]
        .partial_sigs
        .keys()
        .any(|k| k.inner == key_a()));
    assert!(back.inputs[1].partial_sigs.is_empty() && back.inputs[2].partial_sigs.is_empty());
    assert_eq!(
        node.0
            .borrow()
            .calls
            .iter()
            .filter(|c| *c == "finalizepsbt")
            .count(),
        0
    );
}

#[test]
fn a_pushed_hash_of_the_key_is_not_a_reason_to_hint() {
    // `script_has_key` still scopes by hash160 for ownership; the hint needs the key itself
    let (node, handle) = node_with(true);
    let (mut s, _keep) = signer(&node);
    let own_input = p2sh(0x11);
    let hash = hash160::Hash::hash(&key_bytes(KEY_A)).to_byte_array();
    let mut b = vec![0x76, 0xa9, 20];
    b.extend_from_slice(&hash);
    b.extend_from_slice(&[0x88, 0xac]);
    let ws = ScriptBuf::from_bytes(b);
    let p = psbt_of(&[(own_input, None, None), (p2wsh(&ws), None, Some(ws))]);
    let r = s.sign_psbt(NET, &handle, &hex_of(&p)).unwrap();
    let seen = parse_b64(&node.0.borrow().seen[0]);
    assert!(seen.inputs.iter().all(|i| i.bip32_derivation.is_empty()));
    assert_eq!(seen, p);
    // no hinted input: the unhinted rule applies (the node changed nothing)
    assert_eq!(r["isValid"], json!(false));
}

#[test]
fn p2sh_p2wsh_and_redeem_script_inputs_are_hinted_through_either_script() {
    let (node, handle) = node_with(true);
    let (mut s, _keep) = signer(&node);
    let chan = multisig(&[KEY_A, KEY_B]);
    let nested_rs = p2wsh(&chan); // redeem script of a p2sh-p2wsh input
    let nested_spk = ScriptBuf::new_p2sh(&nested_rs.script_hash());
    let bare = multisig(&[KEY_B, KEY_A]);
    let p = psbt_of(&[
        (nested_spk, Some(nested_rs), Some(chan)),
        (ScriptBuf::new_p2sh(&bare.script_hash()), Some(bare), None),
    ]);
    let r = s.sign_psbt(NET, &handle, &hex_of(&p)).unwrap();
    let seen = parse_b64(&node.0.borrow().seen[0]);
    assert!(seen.inputs[0].bip32_derivation.contains_key(&key_a()));
    assert!(seen.inputs[1].bip32_derivation.contains_key(&key_a()));
    assert_eq!(r["isValid"], json!(true));
}

#[test]
fn isvalid_is_false_when_the_node_does_not_sign_a_hinted_input() {
    let (node, handle) = node_with(true);
    // the node answers with the PSBT unsigned (wallet does not hold the key)
    node.0.borrow_mut().wallet_key = None;
    let (mut s, _keep) = signer(&node);
    let chan = multisig(&[KEY_A, KEY_B]);
    let p = psbt_of(&[(p2wsh(&chan), None, Some(chan))]);
    let r = s.sign_psbt(NET, &handle, &hex_of(&p)).unwrap();
    assert_eq!(r["isValid"], json!(false));
    assert_eq!(r["isFinished"], json!(false));
    // the hint did not make the PSBT "changed": the entry we added is stripped again
    let back = Psbt::deserialize(&hex_to_bytes(r["psbtHex"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(back, p);
}

#[test]
fn isvalid_needs_the_signature_on_every_hinted_input() {
    let (node, handle) = node_with(true);
    let (mut s, _keep) = signer(&node);
    let chan = multisig(&[KEY_A, KEY_B]);
    let chan2 = multisig(&[KEY_A, KEY_B, KEY_B]);
    let p = psbt_of(&[
        (p2wsh(&chan), None, Some(chan)),
        (p2wsh(&chan2), None, Some(chan2)),
    ]);
    let r = s.sign_psbt(NET, &handle, &hex_of(&p)).unwrap();
    assert_eq!(r["isValid"], json!(true));
    let seen = parse_b64(&node.0.borrow().seen[0]);
    assert!(seen
        .inputs
        .iter()
        .all(|i| i.bip32_derivation.contains_key(&key_a())));
    // the node signs input 0 only: one hinted input is unsigned, so the reply is not valid
    node.0.borrow_mut().skip = vec![1];
    let r = s.sign_psbt(NET, &handle, &hex_of(&p)).unwrap();
    assert_eq!(r["isValid"], json!(false));
    let back = Psbt::deserialize(&hex_to_bytes(r["psbtHex"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(back.inputs[0].partial_sigs.len(), 1);
    assert!(back.inputs[1].partial_sigs.is_empty());
}

#[test]
fn a_finalized_reply_is_valid_and_finalized_through_finalizepsbt() {
    let (node, handle) = node_with(true);
    node.0.borrow_mut().finalize = true;
    let (mut s, _keep) = signer(&node);
    let chan = multisig(&[KEY_A, KEY_B]);
    let p = psbt_of(&[(p2wsh(&chan), None, Some(chan))]);
    let r = s.sign_psbt(NET, &handle, &hex_of(&p)).unwrap();
    assert_eq!(r["isValid"], json!(true));
    assert_eq!(r["isFinished"], json!(true));
    assert_eq!(r["finalHex"], json!("0200final"));
}

#[test]
fn an_existing_derivation_entry_is_kept_and_not_counted_as_added() {
    let (node, handle) = node_with(true);
    let (mut s, _keep) = signer(&node);
    let chan = multisig(&[KEY_A, KEY_B]);
    let mut p = psbt_of(&[(p2wsh(&chan), None, Some(chan))]);
    let theirs = (
        Fingerprint::from_str("deadbeef").unwrap(),
        DerivationPath::from_str("m/1/2").unwrap(),
    );
    p.inputs[0].bip32_derivation.insert(key_a(), theirs.clone());
    let r = s.sign_psbt(NET, &handle, &hex_of(&p)).unwrap();
    // the caller's entry is passed through unchanged (and kept in the reply)
    assert_eq!(
        parse_b64(&node.0.borrow().seen[0]).inputs[0].bip32_derivation[&key_a()],
        theirs
    );
    let back = Psbt::deserialize(&hex_to_bytes(r["psbtHex"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(back.inputs[0].bip32_derivation[&key_a()], theirs);
    assert_eq!(r["isValid"], json!(true));
}

#[test]
fn without_key_origin_the_psbt_is_sent_unchanged_and_the_old_validity_rule_applies() {
    let (node, handle) = node_with(false);
    let (mut s, _keep) = signer(&node);
    let chan = multisig(&[KEY_A, KEY_B]);
    let p = psbt_of(&[(p2wsh(&chan), None, Some(chan.clone()))]);
    let hex = hex_of(&p);
    // a descriptor-style node cannot sign it, and nothing changed: invalid, as before
    let r = s.sign_psbt(NET, &handle, &hex).unwrap();
    let sent = node.0.borrow().seen[0].clone();
    assert_eq!(sent, b64_encode(&hex_to_bytes(&hex).unwrap()));
    assert_eq!(r["isValid"], json!(false));
    // a legacy wallet with the script imported signs without any hint: the reply changed
    node.0.borrow_mut().needs_hint = false;
    let r = s.sign_psbt(NET, &handle, &hex).unwrap();
    let sent = node.0.borrow().seen[1].clone();
    assert_eq!(sent, b64_encode(&hex_to_bytes(&hex).unwrap()));
    assert_eq!(r["isValid"], json!(true));
}

#[test]
fn a_malformed_key_origin_falls_back_like_a_missing_one() {
    for (fp, path) in [("xyz", KEYPATH), (FP, "not a path"), ("3614f2", KEYPATH)] {
        let (node, handle) = node_with(true);
        let own = address_of(&p2sh(0x11));
        {
            let mut s = node.0.borrow_mut();
            let i = s.info.get_mut(&own).unwrap();
            i["hdmasterfingerprint"] = json!(fp);
            i["hdkeypath"] = json!(path);
        }
        let (mut s, _keep) = signer(&node);
        let chan = multisig(&[KEY_A, KEY_B]);
        let p = psbt_of(&[(p2wsh(&chan), None, Some(chan))]);
        s.sign_psbt(NET, &handle, &hex_of(&p)).unwrap();
        assert_eq!(parse_b64(&node.0.borrow().seen[0]), p, "{fp} {path}");
    }
}

#[test]
fn key_origin_accepts_h_and_apostrophe_hardened_markers() {
    let info = |path: &str| json!({"hdmasterfingerprint": FP, "hdkeypath": path});
    let k = key_bytes(KEY_A);
    let a = key_origin(&info("m/84h/1h/0h/0/7"), &k).unwrap();
    let b = key_origin(&info("m/84'/1'/0'/0/7"), &k).unwrap();
    assert_eq!(a.path, b.path);
    assert_eq!(a.fingerprint, Fingerprint::from_str(FP).unwrap());
    assert!(key_origin(&json!({}), &k).is_none());
    assert!(key_origin(&info("m/0"), &[5u8; 33]).is_none()); // not a public key
}

#[test]
fn foreign_inputs_still_stop_the_signer_before_the_node_is_asked() {
    let (node, handle) = node_with(true);
    let other = p2sh(0x33);
    node.0
        .borrow_mut()
        .info
        .insert(address_of(&other), json!({"ismine": true}));
    let (mut s, _keep) = signer(&node);
    let chan = multisig(&[KEY_A, KEY_B]);
    let p = psbt_of(&[(p2wsh(&chan), None, Some(chan)), (other, None, None)]);
    let e = s.sign_psbt(NET, &handle, &hex_of(&p)).unwrap_err();
    assert!(e.contains("belongs to another address"), "{e}");
    assert!(node.0.borrow().seen.is_empty());
}
