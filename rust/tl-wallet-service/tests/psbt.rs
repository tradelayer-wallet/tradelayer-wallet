mod common;
use bitcoin::absolute::LockTime;
use bitcoin::script::PushBytesBuf;
use bitcoin::transaction::Version;
use bitcoin::{OutPoint, PublicKey, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid, Witness};
use common::*;
use std::str::FromStr;
use tl_wallet_service::amount::Amount;
use tl_wallet_service::psbt::*;
use tl_wallet_service::txbuilder::Utxo;

fn p2wpkh_spk(pk_hex: &str) -> ScriptBuf {
    let pk = PublicKey::from_str(pk_hex).unwrap();
    ScriptBuf::new_p2wpkh(&pk.wpubkey_hash().unwrap())
}

fn op_return(data: &[u8]) -> ScriptBuf {
    ScriptBuf::new_op_return(PushBytesBuf::try_from(data.to_vec()).unwrap())
}

fn tx(inputs: &[(u8, u32)], outs: Vec<TxOut>) -> Transaction {
    Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: inputs
            .iter()
            .map(|(n, v)| TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_str(&txid(*n)).unwrap(),
                    vout: *v,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            })
            .collect(),
        output: outs,
    }
}

fn out(spk: ScriptBuf, sat: u64) -> TxOut {
    TxOut {
        value: bitcoin::Amount::from_sat(sat),
        script_pubkey: spk,
    }
}

fn funded(n: u8, vout: u32, amount: u64, pk: &str) -> Utxo {
    Utxo {
        txid: txid(n),
        vout,
        amount: sat(amount),
        confirmations: 2,
        script_pub_key: hex(p2wpkh_spk(pk).as_bytes()),
        redeem_script: None,
        pubkey: Some(pk.into()),
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

struct Chain(Vec<Utxo>);
impl UtxoView for Chain {
    fn amount_of(&mut self, txid: &str, vout: u32) -> Option<Amount> {
        self.0
            .iter()
            .find(|u| u.txid == txid && u.vout == vout)
            .map(|u| u.amount)
    }
}

#[test]
fn build_psbt_attaches_witness_utxo() {
    let u = funded(1, 0, 1_000_000, G);
    let t = tx(&[(1, 0)], vec![out(p2wpkh_spk(G2), 900_000)]);
    let hexs = build_psbt(&tx_to_hex(&t), std::slice::from_ref(&u)).unwrap();
    assert!(hexs.starts_with("70736274ff")); // "psbt\xff"
}

#[test]
fn build_psbt_rejects_unknown_inputs_and_script_mismatch() {
    let u = funded(1, 0, 1_000_000, G);
    let t = tx(&[(2, 0)], vec![out(p2wpkh_spk(G2), 1)]);
    assert!(matches!(
        build_psbt(&tx_to_hex(&t), std::slice::from_ref(&u)),
        Err(PsbtError::UnknownInput(_, 0))
    ));
    // scriptPubKey from the node does not commit to the supplied pubkey
    let mut bad = u.clone();
    bad.script_pub_key = hex(p2wpkh_spk(G3).as_bytes());
    let t = tx(&[(1, 0)], vec![out(p2wpkh_spk(G2), 1)]);
    assert_eq!(
        build_psbt(&tx_to_hex(&t), &[bad]),
        Err(PsbtError::ScriptMismatch(0))
    );
    // neither pubkey nor redeem script
    let mut nokey = u.clone();
    nokey.pubkey = None;
    assert_eq!(
        build_psbt(&tx_to_hex(&t), &[nokey]),
        Err(PsbtError::MissingKeyData(0))
    );
    // garbage
    assert_eq!(
        build_psbt("zz", std::slice::from_ref(&u)),
        Err(PsbtError::BadHex)
    );
    assert_eq!(build_psbt("00", &[u]), Err(PsbtError::BadTx));
}

#[test]
fn build_psbt_supports_p2sh_wrapped_multisig() {
    // 2-of-2 multisig script, committed to as P2SH(P2WSH(script)).
    let mut ms = vec![0x52u8];
    for pk in [G, G2] {
        let b = (0..pk.len() / 2)
            .map(|i| u8::from_str_radix(&pk[2 * i..2 * i + 2], 16).unwrap())
            .collect::<Vec<_>>();
        ms.push(b.len() as u8);
        ms.extend(b);
    }
    ms.push(0x52);
    ms.push(0xae);
    let ws = ScriptBuf::from_bytes(ms.clone());
    let program = ScriptBuf::new_p2wsh(&ws.wscript_hash());
    let spk = ScriptBuf::new_p2sh(&program.script_hash());
    let u = Utxo {
        txid: txid(3),
        vout: 1,
        amount: sat(3_600),
        confirmations: 1,
        script_pub_key: hex(spk.as_bytes()),
        redeem_script: Some(hex(&ms)),
        pubkey: None,
    };
    let t = tx(&[(3, 1)], vec![out(p2wpkh_spk(G3), 3_000)]);
    assert!(build_psbt(&tx_to_hex(&t), std::slice::from_ref(&u)).is_ok());
    // native P2WSH works as well
    let mut native = u.clone();
    native.script_pub_key = hex(program.as_bytes());
    assert!(build_psbt(&tx_to_hex(&t), &[native]).is_ok());
}

#[test]
fn repaired_sign_guard_binds_amounts_and_fee() {
    let u = funded(1, 0, 1_000_000, G);
    let chain = Chain(vec![u.clone()]);
    let max = sat(60_000);
    // fee exactly at the bound passes
    let t = tx(&[(1, 0)], vec![out(p2wpkh_spk(G2), 940_000)]);
    assert_eq!(
        guard_sign(
            &tx_to_hex(&t),
            std::slice::from_ref(&u),
            &mut Chain(chain.0.clone()),
            max
        )
        .unwrap(),
        sat(60_000)
    );
    // fee one satoshi above the bound
    let t = tx(&[(1, 0)], vec![out(p2wpkh_spk(G2), 939_999)]);
    assert_eq!(
        guard_sign(
            &tx_to_hex(&t),
            std::slice::from_ref(&u),
            &mut Chain(chain.0.clone()),
            max
        ),
        Err(PsbtError::FeeTooHigh {
            fee: 60_001,
            max: 60_000
        })
    );
    // overspend
    let t = tx(&[(1, 0)], vec![out(p2wpkh_spk(G2), 1_000_001)]);
    assert_eq!(
        guard_sign(
            &tx_to_hex(&t),
            std::slice::from_ref(&u),
            &mut Chain(chain.0.clone()),
            max
        ),
        Err(PsbtError::Overspend)
    );
    // caller understates the input amount (segwit sighash fee attack): chain disagrees
    let mut lie = u.clone();
    lie.amount = sat(1_000);
    let t = tx(&[(1, 0)], vec![out(p2wpkh_spk(G2), 100)]);
    assert!(matches!(
        guard_sign(&tx_to_hex(&t), &[lie], &mut Chain(chain.0.clone()), max),
        Err(PsbtError::AmountMismatch(_, 0))
    ));
    // unknown to the chain
    let t = tx(&[(1, 0)], vec![out(p2wpkh_spk(G2), 940_000)]);
    assert!(matches!(
        guard_sign(
            &tx_to_hex(&t),
            std::slice::from_ref(&u),
            &mut Chain(vec![]),
            max
        ),
        Err(PsbtError::AmountMismatch(_, 0))
    ));
    // input not among the approved ones
    let t = tx(&[(1, 0), (2, 0)], vec![out(p2wpkh_spk(G2), 940_000)]);
    assert!(matches!(
        guard_sign(
            &tx_to_hex(&t),
            std::slice::from_ref(&u),
            &mut Chain(chain.0.clone()),
            max
        ),
        Err(PsbtError::UnknownInput(_, 0))
    ));
}

fn trade_expectation(channel: Utxo, seller_pk: &str) -> TradeTxExpectation {
    TradeTxExpectation {
        channel_inputs: vec![channel],
        seller_script_pub_key: hex(p2wpkh_spk(seller_pk).as_bytes()),
        seller_min_out: sat(3_600),
        payload_prefix: b"tl-trade".to_vec(),
        max_fee: sat(180_000),
    }
}

fn trade_psbt(
    channel: &Utxo,
    buyer: &Utxo,
    seller_pay: u64,
    payload: &[u8],
    buyer_change: u64,
) -> String {
    let t = tx(
        &[(4, 1), (1, 0)],
        vec![
            out(p2wpkh_spk(G2), seller_pay),
            out(p2wpkh_spk(G), buyer_change),
            out(op_return(payload), 0),
        ],
    );
    let _ = (channel, buyer);
    let mut psbt = bitcoin::psbt::Psbt::from_unsigned_tx(t).unwrap();
    for (i, u) in [channel, buyer].iter().enumerate() {
        psbt.inputs[i].witness_utxo = Some(out(
            ScriptBuf::from_bytes(
                (0..u.script_pub_key.len() / 2)
                    .map(|k| u8::from_str_radix(&u.script_pub_key[2 * k..2 * k + 2], 16).unwrap())
                    .collect(),
            ),
            u.amount.sat(),
        ));
    }
    hex(&psbt.serialize())
}

#[test]
fn repaired_seller_checks_the_trade_psbt_before_signing() {
    let channel = funded(4, 1, 3_600, G3);
    let buyer = funded(1, 0, 1_000_000, G);
    let exp = trade_expectation(channel.clone(), G2);
    // honest PSBT: fee = 3_600 + 1_000_000 - 3_600 - 940_000 - ... compute
    let ok = trade_psbt(&channel, &buyer, 3_600, b"tl-trade-v1", 1_000_000 - 100_000);
    // inputs 1_003_600; outputs 3_600 + 900_000 = 903_600; fee 100_000
    assert_eq!(check_trade_psbt(&ok, &exp), Ok(()));

    // buyer pays the seller too little
    let short = trade_psbt(&channel, &buyer, 3_599, b"tl-trade-v1", 900_000);
    assert_eq!(
        check_trade_psbt(&short, &exp),
        Err(PsbtError::SellerOutputMissing)
    );
    // wrong payload
    let bad_payload = trade_psbt(&channel, &buyer, 3_600, b"drain-all", 900_000);
    assert_eq!(
        check_trade_psbt(&bad_payload, &exp),
        Err(PsbtError::PayloadMismatch)
    );
    // confiscatory fee: everything goes to the miner
    let fee = trade_psbt(&channel, &buyer, 3_600, b"tl-trade-v1", 700_000);
    assert!(matches!(
        check_trade_psbt(&fee, &exp),
        Err(PsbtError::FeeTooHigh { .. })
    ));
    // overspend
    let over = trade_psbt(&channel, &buyer, 3_600, b"tl-trade-v1", 2_000_000);
    assert_eq!(check_trade_psbt(&over, &exp), Err(PsbtError::Overspend));
    // channel input missing from the transaction
    let mut missing = exp.clone();
    missing.channel_inputs = vec![funded(5, 0, 3_600, G3)];
    assert!(matches!(
        check_trade_psbt(&ok, &missing),
        Err(PsbtError::MissingChannelInput(_, 0))
    ));
    // channel input value misreported
    let mut wrong = exp.clone();
    wrong.channel_inputs[0].amount = sat(3_601);
    assert!(matches!(
        check_trade_psbt(&ok, &wrong),
        Err(PsbtError::ChannelInputMismatch(_, 1))
    ));
    // not a psbt
    assert_eq!(check_trade_psbt("00", &exp), Err(PsbtError::BadPsbt));
}

#[test]
fn guard_psbt_checks_witness_amounts_against_the_chain() {
    let channel = funded(4, 1, 3_600, G3);
    let buyer = funded(1, 0, 1_000_000, G);
    let p = trade_psbt(&channel, &buyer, 3_600, b"tl-trade-v1", 940_000);
    let chain = || Chain(vec![channel.clone(), buyer.clone()]);
    assert_eq!(
        guard_psbt(&p, &mut chain(), sat(180_000)).unwrap(),
        sat(60_000)
    );
    assert!(matches!(
        guard_psbt(&p, &mut chain(), sat(59_999)),
        Err(PsbtError::FeeTooHigh { .. })
    ));
    let mut tampered = chain();
    tampered.0[1].amount = sat(10);
    assert!(matches!(
        guard_psbt(&p, &mut tampered, sat(180_000)),
        Err(PsbtError::AmountMismatch(_, 0))
    ));
    assert_eq!(psbt_input_count(&p).unwrap(), 2);
}
