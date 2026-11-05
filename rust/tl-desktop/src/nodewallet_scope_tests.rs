//! `tln1:<address>` handles: the node wallet signs only for inputs that belong to the address.

use super::*;
use std::collections::BTreeMap;
use tl_wallet_service::amount::Amount;

const NET: &str = "LTCTEST";
const PK_A: [u8; 33] = [2; 33];
const PK_B: [u8; 33] = [3; 33];

#[derive(Default)]
struct State {
    /// `getaddressinfo` answers by address.
    info: BTreeMap<String, Value>,
    other: BTreeMap<String, Value>,
    calls: Vec<(String, Vec<Value>)>,
}

#[derive(Clone, Default)]
struct AddrNode(Rc<RefCell<State>>);

impl AddrNode {
    fn calls_of(&self, m: &str) -> usize {
        self.0.borrow().calls.iter().filter(|(n, _)| n == m).count()
    }
}

impl RpcBackend for AddrNode {
    fn call(&mut self, method: &str, params: &[Value]) -> CallResult {
        let mut s = self.0.borrow_mut();
        s.calls.push((method.to_string(), params.to_vec()));
        if method == "getaddressinfo" {
            let a = params[0].as_str().unwrap_or("");
            return Ok(s.info.get(a).cloned().unwrap_or(json!({"ismine": false})));
        }
        s.other
            .get(method)
            .cloned()
            .ok_or_else(|| format!("{method}: not scripted"))
    }
}

fn signer(node: &AddrNode) -> (NodeWalletSigner, Shared) {
    let shared: Shared = Rc::new(RefCell::new(Box::new(node.clone())));
    let slot = NodeSlot::default();
    slot.set(&shared);
    (NodeWalletSigner::new(slot), shared)
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

fn multisig(keys: &[[u8; 33]]) -> ScriptBuf {
    let mut b = vec![0x52];
    for k in keys {
        b.push(33);
        b.extend_from_slice(k);
    }
    b.extend_from_slice(&[0x52, 0xae]);
    ScriptBuf::from_bytes(b)
}

/// A PSBT with one input per `(scriptPubKey, witness script)`.
fn psbt(inputs: &[(ScriptBuf, Option<ScriptBuf>)]) -> String {
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
    for (i, (spk, ws)) in inputs.iter().enumerate() {
        p.inputs[i].witness_utxo = Some(bitcoin::TxOut {
            value: bitcoin::Amount::from_sat(1_000_000),
            script_pubkey: spk.clone(),
        });
        p.inputs[i].witness_script = ws.clone();
    }
    bytes_to_hex(&p.serialize())
}

/// A node that owns `own` (with public key `PK_A`) and nothing else.
fn node_owning(own: &ScriptBuf, extra_mine: &[&ScriptBuf]) -> AddrNode {
    let node = AddrNode::default();
    {
        let mut s = node.0.borrow_mut();
        s.info.insert(
            address_of(own),
            json!({"ismine": true, "embedded": {"pubkey": bytes_to_hex(&PK_A)}}),
        );
        for e in extra_mine {
            s.info.insert(address_of(e), json!({"ismine": true}));
        }
        for fill in [0x22u8, 0x33, 0x44] {
            let a = address_of(&p2sh(fill));
            s.info.entry(a).or_insert(json!({"ismine": false}));
        }
        s.other.insert(
            "walletprocesspsbt".into(),
            json!({"psbt": "cHNidP8BAA==", "complete": false}),
        );
        s.other.insert(
            "signrawtransactionwithwallet".into(),
            json!({"hex": "0200signed", "complete": true}),
        );
    }
    node
}

fn handle_of(script: &ScriptBuf) -> String {
    format!("{NODE_HANDLE_PREFIX}{}", address_of(script))
}

fn utxo(n: u8, spk: &ScriptBuf, ws: Option<&ScriptBuf>) -> Utxo {
    Utxo {
        txid: txid_hex(n),
        vout: 0,
        amount: Amount::from_sat(1_000_000).unwrap(),
        confirmations: 3,
        script_pub_key: bytes_to_hex(spk.as_bytes()),
        redeem_script: ws.map(|w| bytes_to_hex(w.as_bytes())),
        pubkey: None,
    }
}

fn txid_hex(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}

#[test]
fn a_handle_signs_when_its_address_owns_an_input_and_the_rest_are_nobodys() {
    let own = p2sh(0x11);
    let node = node_owning(&own, &[]);
    let (mut s, _keep) = signer(&node);
    let h = handle_of(&own);
    let p = psbt(&[(own.clone(), None), (p2sh(0x22), None)]);
    let r = s.sign_psbt(NET, &h, &p).unwrap();
    assert_eq!(r["isValid"], json!(true));
    assert_eq!(node.calls_of("walletprocesspsbt"), 1);
    // the handle address was looked up once, the foreign input once
    assert_eq!(node.calls_of("getaddressinfo"), 2);
}

#[test]
fn an_input_of_another_wallet_address_is_refused_before_the_node_signs() {
    let own = p2sh(0x11);
    let other = p2sh(0x33);
    let node = node_owning(&own, &[&other]);
    let (mut s, _keep) = signer(&node);
    let h = handle_of(&own);
    let p = psbt(&[(own.clone(), None), (other.clone(), None)]);
    let e = s.sign_psbt(NET, &h, &p).unwrap_err();
    assert!(e.contains("input 1 belongs to another address"), "{e}");
    assert_eq!(node.calls_of("walletprocesspsbt"), 0);
    let inputs = [utxo(1, &own, None), utxo(2, &other, None)];
    let e = s.sign_tx(NET, "0200raw", &h, &inputs).unwrap_err();
    assert!(e.contains("belongs to another address"), "{e}");
    assert_eq!(node.calls_of("signrawtransactionwithwallet"), 0);
}

#[test]
fn a_handle_with_no_input_of_its_own_is_refused() {
    let own = p2sh(0x11);
    let node = node_owning(&own, &[]);
    let (mut s, _keep) = signer(&node);
    let h = handle_of(&own);
    let p = psbt(&[(p2sh(0x22), None), (p2sh(0x33), None)]);
    assert!(s
        .sign_psbt(NET, &h, &p)
        .unwrap_err()
        .contains("no input belongs"));
    assert!(s
        .sign_tx(NET, "0200raw", &h, &[utxo(1, &p2sh(0x22), None)])
        .unwrap_err()
        .contains("no input belongs"));
    assert_eq!(
        node.calls_of("walletprocesspsbt") + node.calls_of("signrawtransactionwithwallet"),
        0
    );
}

#[test]
fn a_channel_multisig_holding_the_addresses_key_belongs_to_it() {
    let own = p2sh(0x11);
    let node = node_owning(&own, &[]);
    let (mut s, _keep) = signer(&node);
    let h = handle_of(&own);
    let mine = multisig(&[PK_A, PK_B]);
    let theirs = multisig(&[PK_B, PK_B]);
    let chan = ScriptBuf::new_p2wsh(&mine.wscript_hash());
    let foreign_chan = ScriptBuf::new_p2wsh(&theirs.wscript_hash());
    // the swap shape: channel input plus the counterparty's commit input
    let p = psbt(&[(chan.clone(), Some(mine.clone())), (p2sh(0x22), None)]);
    assert!(s.sign_psbt(NET, &h, &p).is_ok());
    // a channel without the key belongs to nobody
    let p = psbt(&[(foreign_chan.clone(), Some(theirs.clone()))]);
    assert!(s
        .sign_psbt(NET, &h, &p)
        .unwrap_err()
        .contains("no input belongs"));
    // sign-tx carries the multisig script as the input's redeemScript
    let inputs = [utxo(1, &chan, Some(&mine)), utxo(2, &p2sh(0x22), None)];
    assert!(s.sign_tx(NET, "0200raw", &h, &inputs).is_ok());
    assert_eq!(node.calls_of("signrawtransactionwithwallet"), 1);
}

#[test]
fn a_handle_for_an_address_outside_the_wallet_or_a_bad_address_never_reaches_the_signer() {
    let own = p2sh(0x11);
    let node = node_owning(&own, &[]);
    node.0
        .borrow_mut()
        .info
        .insert(address_of(&own), json!({"ismine": false}));
    let (mut s, _keep) = signer(&node);
    let p = psbt(&[(own.clone(), None)]);
    assert!(s
        .sign_psbt(NET, &handle_of(&own), &p)
        .unwrap_err()
        .contains("not in the node wallet"));
    for bad in [
        "tln1:",
        "tln1:not an address",
        "tln1:QS67ivwZADneXHQzwG8pE8nS8VkeVC9AaH",
    ] {
        assert!(s.sign_psbt(NET, bad, &p).is_err(), "{bad}");
        assert!(s.sign_tx(NET, "00", bad, &[]).is_err(), "{bad}");
    }
    assert!(s.sign_psbt("DOGE", &handle_of(&own), &p).is_err());
    assert_eq!(node.calls_of("walletprocesspsbt"), 0);
}

#[test]
fn sign_tx_under_a_handle_needs_every_input_script() {
    let own = p2sh(0x11);
    let node = node_owning(&own, &[]);
    let (mut s, _keep) = signer(&node);
    let h = handle_of(&own);
    let mut u = utxo(1, &own, None);
    u.script_pub_key.clear();
    assert_eq!(
        s.sign_tx(NET, "0200raw", &h, &[u]).unwrap_err(),
        "input.scriptPubKey missing"
    );
    let mut u = utxo(1, &own, None);
    u.script_pub_key = "zz".into();
    assert!(s.sign_tx(NET, "0200raw", &h, &[u]).is_err());
    // the empty placeholder keeps the old behaviour: no address lookup at all
    let before = node.calls_of("getaddressinfo");
    assert!(s
        .sign_tx(NET, "0200raw", "", &[utxo(1, &own, None)])
        .is_ok());
    assert_eq!(node.calls_of("getaddressinfo"), before);
}

/// FE-speed's network label is Litecoin Testnet by default, but a regtest node's addresses carry its
/// own prefix; the handle address is read with the chain's format, not the label's.
#[test]
fn a_regtest_node_overrides_the_network_label_for_handle_addresses() {
    for (subversion, net) in [
        ("/Satoshi:31.1.0/", Network::BtcRegtest),
        ("/LitecoinCore:0.21.5/", Network::LtcRegtest),
    ] {
        let own = p2sh(0x11);
        let node = node_owning(&own, &[]);
        let addr = Address::from_script(net, &own).unwrap().encode().unwrap();
        {
            let mut s = node.0.borrow_mut();
            s.info.insert(
                addr.clone(),
                json!({"ismine": true, "embedded": {"pubkey": bytes_to_hex(&PK_A)}}),
            );
            for fill in [0x22u8, 0x33, 0x44] {
                let a = Address::from_script(net, &p2sh(fill))
                    .unwrap()
                    .encode()
                    .unwrap();
                s.info.entry(a).or_insert(json!({"ismine": false}));
            }
            s.other
                .insert("getblockchaininfo".into(), json!({"chain": "regtest"}));
            s.other
                .insert("getnetworkinfo".into(), json!({"subversion": subversion}));
        }
        let (mut s, _keep) = signer(&node);
        let h = format!("{NODE_HANDLE_PREFIX}{addr}");
        let p = psbt(&[(own.clone(), None), (p2sh(0x22), None)]);
        let r = s
            .sign_psbt(NET, &h, &p)
            .unwrap_or_else(|e| panic!("{subversion}: {e}"));
        assert_eq!(r["isValid"], json!(true), "{subversion}");
    }
    // the same handle without a regtest chain is read with the label's format, which it does not match
    let own = p2sh(0x11);
    let node = node_owning(&own, &[]);
    let addr = Address::from_script(Network::BtcRegtest, &own)
        .unwrap()
        .encode()
        .unwrap();
    let (mut s, _keep) = signer(&node);
    let e = s
        .sign_psbt(
            NET,
            &format!("{NODE_HANDLE_PREFIX}{addr}"),
            &psbt(&[(own, None)]),
        )
        .unwrap_err();
    assert!(e.starts_with("handle address:"), "{e}");
}
