//! Real-node proof: two descriptor wallets sign a 2-of-2 channel spend through `NodeWalletSigner`
//! with `tln1:` handles. No key export and no script import.
//!
//! Ignored by default; `scripts/regtest-multisig-descriptor.mjs` starts a throwaway regtest node
//! with two descriptor wallets and runs it. Environment:
//!
//! * `TL_REGTEST_URL`: node RPC base URL, e.g. `http://127.0.0.1:18781`
//! * `TL_REGTEST_USER`, `TL_REGTEST_PASS`: RPC credentials
//! * `TL_REGTEST_WALLET_A`, `TL_REGTEST_WALLET_B`: two loaded descriptor wallets
//! * `TL_REGTEST_NETWORK`: `BTCREGTEST` (default) or `LTCREGTEST`
//!
//! Each signer talks to its own wallet through the `/wallet/<name>` URL, the way two nodes would
//! each answer on `/`.

use super::*;
use crate::legacy::RpcClient;
use bitcoin::psbt::Psbt as BtcPsbt;
use tl_wallet_service::amount::Amount;
use tl_wallet_service::multisig::compute_multisig;

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"))
}

struct Wallet {
    shared: Shared,
    signer: NodeWalletSigner,
}

impl Wallet {
    fn open(name: &str) -> Wallet {
        let url = format!(
            "{}/wallet/{name}",
            env("TL_REGTEST_URL").trim_end_matches('/')
        );
        let client = RpcClient::new(&url, &env("TL_REGTEST_USER"), &env("TL_REGTEST_PASS"))
            .expect("rpc client");
        let shared: Shared = Rc::new(RefCell::new(Box::new(client)));
        let slot = NodeSlot::default();
        slot.set(&shared);
        Wallet {
            shared,
            signer: NodeWalletSigner::new(slot),
        }
    }

    fn rpc(&self, method: &str, params: &[Value]) -> Value {
        self.shared
            .borrow_mut()
            .call(method, params)
            .unwrap_or_else(|e| panic!("{method}: {e}"))
    }

    /// A fresh native segwit address with its public key and scriptPubKey.
    fn new_address(&self) -> (String, String, String) {
        let addr = self.rpc("getnewaddress", &[json!(""), json!("bech32")]);
        let addr = addr.as_str().unwrap().to_string();
        let info = self.rpc("getaddressinfo", &[json!(addr)]);
        assert_eq!(info["ismine"], json!(true));
        let pk = info["pubkey"].as_str().expect("pubkey").to_string();
        let spk = info["scriptPubKey"].as_str().unwrap().to_string();
        (addr, pk, spk)
    }
}

fn handle(addr: &str) -> String {
    format!("{NODE_HANDLE_PREFIX}{addr}")
}

fn sats(v: &Value) -> u64 {
    (v.as_f64().expect("amount") * 1e8).round() as u64
}

fn btc(sat: u64) -> Value {
    json!(format!("{}.{:08}", sat / 100_000_000, sat % 100_000_000)
        .parse::<f64>()
        .unwrap())
}

fn psbt_from_hex(h: &str) -> BtcPsbt {
    BtcPsbt::deserialize(&hex_to_bytes(h).expect("hex")).expect("psbt")
}

#[test]
#[ignore = "needs a regtest node; run scripts/regtest-multisig-descriptor.mjs"]
fn two_descriptor_wallets_sign_the_channel_multisig_and_the_spend_confirms() {
    let net_label = std::env::var("TL_REGTEST_NETWORK").unwrap_or_else(|_| "BTCREGTEST".into());
    let net = Network::parse(&net_label).expect("network");
    // compute-multisig knows the four public-chain labels; the script is the same on regtest
    let script_label = if net == Network::LtcRegtest {
        "LTCTEST"
    } else {
        "BTCTEST"
    };

    let mut a = Wallet::open(&env("TL_REGTEST_WALLET_A"));
    let mut b = Wallet::open(&env("TL_REGTEST_WALLET_B"));
    for w in [&a, &b] {
        let info = w.rpc("getwalletinfo", &[]);
        assert_eq!(info["descriptors"], json!(true), "descriptor wallets only");
    }
    let (addr_a, pk_a, _) = a.new_address();
    let (addr_b, pk_b, _) = b.new_address();

    // the 2-of-2 channel, computed by the Rust compute-multisig implementation
    let ms = compute_multisig(Some(&json!(2)), Some(&json!([pk_a, pk_b])), script_label)
        .expect("compute_multisig");
    let redeem_hex = ms["redeemScript"].as_str().unwrap().to_string();
    let chan_spk_hex = ms["scriptPubKey"].as_str().unwrap().to_string();
    let chan_spk = ScriptBuf::from_bytes(hex_to_bytes(&chan_spk_hex).unwrap());
    let chan_addr = Address::from_script(net, &chan_spk)
        .unwrap()
        .encode()
        .unwrap();
    println!("channel {chan_addr} = 2-of-2 [{pk_a}, {pk_b}]");

    // ---- fund A: mature coinbase to A's address
    a.rpc("generatetoaddress", &[json!(101), json!(addr_a)]);
    let utxos = a.rpc(
        "listunspent",
        &[json!(1), json!(9_999_999), json!([addr_a])],
    );
    let u = utxos
        .as_array()
        .unwrap()
        .iter()
        .find(|u| sats(&u["amount"]) >= 5_000_000_000)
        .expect("mature coinbase")
        .clone();
    let in_sat = sats(&u["amount"]);

    // ---- commit-style funding of the channel: sign-tx with a tln1: handle on a descriptor wallet
    let chan_sat = 100_000_000u64;
    let fee_sat = 10_000u64;
    let change_sat = in_sat - chan_sat - fee_sat;
    let (change_addr, _, _) = a.new_address();
    let raw = a.rpc(
        "createrawtransaction",
        &[
            json!([{"txid": u["txid"], "vout": u["vout"]}]),
            json!([{chan_addr.clone(): btc(chan_sat)}, {change_addr.clone(): btc(change_sat)}]),
        ],
    );
    let fund_in = Utxo {
        txid: u["txid"].as_str().unwrap().to_string(),
        vout: u["vout"].as_u64().unwrap() as u32,
        amount: Amount::from_sat(in_sat).unwrap(),
        confirmations: u["confirmations"].as_u64().unwrap_or(0) as u32,
        script_pub_key: u["scriptPubKey"].as_str().unwrap().to_string(),
        redeem_script: None,
        pubkey: None,
    };
    let signed = a
        .signer
        .sign_tx(
            &net_label,
            raw.as_str().unwrap(),
            &handle(&addr_a),
            &[fund_in],
        )
        .expect("sign-tx under a handle on a descriptor wallet");
    assert_eq!(signed["isValid"], json!(true), "{signed}");
    assert_eq!(signed["isFinished"], json!(true));
    let fund_txid = a
        .rpc("sendrawtransaction", &[signed["signedHex"].clone()])
        .as_str()
        .unwrap()
        .to_string();
    let tip = a.rpc("generatetoaddress", &[json!(1), json!(change_addr)]);
    let fund_block = tip[0].as_str().unwrap().to_string();
    let fund_tx = a.rpc(
        "getrawtransaction",
        &[json!(fund_txid), json!(true), json!(fund_block)],
    );
    assert!(fund_tx["confirmations"].as_u64().unwrap() >= 1);
    let chan_vout = fund_tx["vout"]
        .as_array()
        .unwrap()
        .iter()
        .position(|o| o["scriptPubKey"]["hex"] == json!(chan_spk_hex))
        .expect("channel output") as u32;
    assert_eq!(
        sats(&fund_tx["vout"][chan_vout as usize]["value"]),
        chan_sat
    );
    println!("funding txid {fund_txid}:{chan_vout}");

    // ---- the channel spend, built with the bitcoin crate: witness_utxo + witness_script
    let (out_a_addr, _, out_a_spk) = a.new_address();
    let (out_b_addr, _, out_b_spk) = b.new_address();
    let (out_a_sat, out_b_sat) = (40_000_000u64, 59_990_000u64); // fee 10_000
    let tx = bitcoin::Transaction {
        version: bitcoin::transaction::Version::TWO,
        lock_time: bitcoin::absolute::LockTime::ZERO,
        input: vec![bitcoin::TxIn {
            previous_output: bitcoin::OutPoint {
                txid: fund_txid.parse().unwrap(),
                vout: chan_vout,
            },
            sequence: bitcoin::Sequence::ENABLE_RBF_NO_LOCKTIME,
            ..Default::default()
        }],
        output: vec![
            bitcoin::TxOut {
                value: bitcoin::Amount::from_sat(out_a_sat),
                script_pubkey: ScriptBuf::from_bytes(hex_to_bytes(&out_a_spk).unwrap()),
            },
            bitcoin::TxOut {
                value: bitcoin::Amount::from_sat(out_b_sat),
                script_pubkey: ScriptBuf::from_bytes(hex_to_bytes(&out_b_spk).unwrap()),
            },
        ],
    };
    let mut psbt = BtcPsbt::from_unsigned_tx(tx).unwrap();
    psbt.inputs[0].witness_utxo = Some(bitcoin::TxOut {
        value: bitcoin::Amount::from_sat(chan_sat),
        script_pubkey: chan_spk.clone(),
    });
    psbt.inputs[0].witness_script = Some(ScriptBuf::from_bytes(hex_to_bytes(&redeem_hex).unwrap()));
    let psbt_hex = bytes_to_hex(&psbt.serialize());

    // control: a descriptor wallet given the bare PSBT does not sign the script it never imported
    let bare = a.rpc(
        "walletprocesspsbt",
        &[
            json!(b64_encode(&psbt.serialize())),
            json!(true),
            json!("ALL"),
            json!(true),
        ],
    );
    let bare_psbt =
        BtcPsbt::deserialize(&b64_decode(bare["psbt"].as_str().unwrap()).unwrap()).unwrap();
    assert!(
        bare_psbt.inputs[0].partial_sigs.is_empty() && bare["complete"] == json!(false),
        "control: node signed the multisig without a hint: {bare}"
    );
    println!("control: walletprocesspsbt without the hint adds no signature");

    // a handle only works on the wallet that owns the address
    let e = b
        .signer
        .sign_psbt(&net_label, &handle(&addr_a), &psbt_hex)
        .expect_err("a handle for another wallet's address");
    assert!(e.contains("not in the node wallet"), "{e}");

    // ---- A signs, then B signs; each through its own wallet and its own handle
    let ra = a
        .signer
        .sign_psbt(&net_label, &handle(&addr_a), &psbt_hex)
        .expect("A signs");
    assert_eq!(ra["isValid"], json!(true), "{ra}");
    assert_eq!(ra["isFinished"], json!(false));
    let after_a = psbt_from_hex(ra["psbtHex"].as_str().unwrap());
    let key_a = bitcoin::PublicKey::from_slice(&hex_to_bytes(&pk_a).unwrap()).unwrap();
    let key_b = bitcoin::PublicKey::from_slice(&hex_to_bytes(&pk_b).unwrap()).unwrap();
    assert!(after_a.inputs[0].partial_sigs.contains_key(&key_a));
    assert!(!after_a.inputs[0].partial_sigs.contains_key(&key_b));
    assert!(
        after_a.inputs[0].bip32_derivation.is_empty(),
        "A's key origin must not travel to B"
    );

    let rb = b
        .signer
        .sign_psbt(
            &net_label,
            &handle(&addr_b),
            ra["psbtHex"].as_str().unwrap(),
        )
        .expect("B signs");
    assert_eq!(rb["isValid"], json!(true), "{rb}");
    assert_eq!(rb["isFinished"], json!(true), "{rb}");
    let final_hex = rb["finalHex"].as_str().expect("finalHex");

    // ---- broadcast, mine, assert what was built is what confirmed
    let spend_txid = b
        .rpc("sendrawtransaction", &[json!(final_hex)])
        .as_str()
        .unwrap()
        .to_string();
    let tip = b.rpc("generatetoaddress", &[json!(1), json!(addr_b)]);
    let spend_block = tip[0].as_str().unwrap().to_string();
    let spend = b.rpc(
        "getrawtransaction",
        &[json!(spend_txid), json!(true), json!(spend_block)],
    );
    assert!(spend["confirmations"].as_u64().unwrap() >= 1);
    assert_eq!(spend["vin"][0]["txid"], json!(fund_txid));
    assert_eq!(spend["vin"][0]["vout"], json!(chan_vout));
    assert_eq!(spend["vout"].as_array().unwrap().len(), 2);
    assert_eq!(spend["vout"][0]["scriptPubKey"]["hex"], json!(out_a_spk));
    assert_eq!(spend["vout"][1]["scriptPubKey"]["hex"], json!(out_b_spk));
    assert_eq!(sats(&spend["vout"][0]["value"]), out_a_sat);
    assert_eq!(sats(&spend["vout"][1]["value"]), out_b_sat);
    assert_eq!(
        spend["vout"][0]["scriptPubKey"]["address"],
        json!(out_a_addr)
    );
    assert_eq!(
        spend["vout"][1]["scriptPubKey"]["address"],
        json!(out_b_addr)
    );
    // the channel output is spent
    assert_eq!(
        b.rpc("gettxout", &[json!(fund_txid), json!(chan_vout)]),
        Value::Null
    );
    println!("spend txid {spend_txid} confirmed in {spend_block}");
    println!("RESULT ok network={net_label} funding={fund_txid} spend={spend_txid}");
}
