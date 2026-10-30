//! Raw-transaction and PSBT handling on top of the `bitcoin` crate (consensus encoding is shared
//! by Litecoin; no address encoding is done here because Litecoin address versions differ, the
//! node's `validateaddress` stays the authority for addresses).
//!
//! Ported: `buildPsbt` (`wallet-server/src/utils/crypto.util.ts:136`). New (repairs):
//! * `guard_sign`: signing is bound to the approved inputs, their on-chain amounts and a fee bound.
//!   Legacy `signRawTransction` trusted the caller's `inputs[].amount` for the segwit sighash and
//!   signed any `rawtx` with any fee (`crypto.util.ts:86-129`, `main.route.ts:91-110`).
//! * `check_trade_psbt`: the seller verifies the buyer's PSBT before adding a signature. Legacy
//!   `seller.ts:onStep4` signed whatever PSBT arrived.

use crate::amount::{Amount, AmountError, MAX_MONEY};
use crate::txbuilder::Utxo;
use bitcoin::consensus::{deserialize, serialize};
use bitcoin::hex::{DisplayHex, FromHex};
use bitcoin::psbt::Psbt;
use bitcoin::script::Instruction;
use bitcoin::{OutPoint, PublicKey, ScriptBuf, Transaction, TxOut, Txid};
use std::str::FromStr;

pub const MAX_TX_HEX_CHARS: usize = 400_000;
pub const MAX_OUTPUTS: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PsbtError {
    BadHex,
    TooLarge,
    BadTx,
    BadPsbt,
    NoInputs,
    TooManyOutputs,
    /// Transaction spends an outpoint that is not among the supplied inputs.
    UnknownInput(String, u32),
    /// Supplied input amount differs from the chain view.
    AmountMismatch(String, u32),
    MissingKeyData(usize),
    ScriptMismatch(usize),
    MissingWitnessUtxo(usize),
    Overspend,
    FeeTooHigh {
        fee: u64,
        max: u64,
    },
    MissingChannelInput(String, u32),
    ChannelInputMismatch(String, u32),
    PayloadMismatch,
    SellerOutputMissing,
    Amount(AmountError),
}

impl From<AmountError> for PsbtError {
    fn from(e: AmountError) -> PsbtError {
        PsbtError::Amount(e)
    }
}

impl std::fmt::Display for PsbtError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for PsbtError {}

fn hex_bytes(s: &str) -> Result<Vec<u8>, PsbtError> {
    if s.len() > MAX_TX_HEX_CHARS {
        return Err(PsbtError::TooLarge);
    }
    Vec::<u8>::from_hex(s).map_err(|_| PsbtError::BadHex)
}

fn script_from_hex(s: &str) -> Result<ScriptBuf, PsbtError> {
    Ok(ScriptBuf::from_bytes(hex_bytes(s)?))
}

pub fn decode_tx(hex: &str) -> Result<Transaction, PsbtError> {
    let tx: Transaction = deserialize(&hex_bytes(hex)?).map_err(|_| PsbtError::BadTx)?;
    if tx.input.is_empty() {
        return Err(PsbtError::NoInputs);
    }
    if tx.output.len() > MAX_OUTPUTS {
        return Err(PsbtError::TooManyOutputs);
    }
    Ok(tx)
}

fn find_input<'a>(inputs: &'a [Utxo], op: &OutPoint) -> Option<&'a Utxo> {
    let id = op.txid.to_string();
    inputs
        .iter()
        .find(|u| u.vout == op.vout && u.txid.eq_ignore_ascii_case(&id))
}

fn sum_outputs(tx: &Transaction) -> Result<Amount, PsbtError> {
    let mut total = Amount::ZERO;
    for o in &tx.output {
        total = total.checked_add(Amount::from_sat(o.value.to_sat())?)?;
    }
    Ok(total)
}

/// Witness program an input commits to: P2WSH of the multisig script or P2WPKH of the pubkey.
fn witness_program(u: &Utxo, idx: usize) -> Result<(ScriptBuf, Option<ScriptBuf>), PsbtError> {
    if let Some(rs) = &u.redeem_script {
        let ws = script_from_hex(rs)?;
        Ok((ScriptBuf::new_p2wsh(&ws.wscript_hash()), Some(ws)))
    } else if let Some(pk) = &u.pubkey {
        let key = PublicKey::from_slice(&hex_bytes(pk)?).map_err(|_| PsbtError::BadHex)?;
        let h = key
            .wpubkey_hash()
            .map_err(|_| PsbtError::MissingKeyData(idx))?;
        Ok((ScriptBuf::new_p2wpkh(&h), None))
    } else {
        Err(PsbtError::MissingKeyData(idx))
    }
}

/// `buildPsbt`: attach witness UTXOs and scripts to the unsigned transaction. The node's
/// `scriptPubKey` is authoritative and must commit to the witness program (native or P2SH-wrapped).
pub fn build_psbt(rawtx_hex: &str, inputs: &[Utxo]) -> Result<String, PsbtError> {
    let tx = decode_tx(rawtx_hex)?;
    let mut psbt = Psbt::from_unsigned_tx(tx.clone()).map_err(|_| PsbtError::BadPsbt)?;
    for (i, txin) in tx.input.iter().enumerate() {
        let u = find_input(inputs, &txin.previous_output).ok_or_else(|| {
            PsbtError::UnknownInput(
                txin.previous_output.txid.to_string(),
                txin.previous_output.vout,
            )
        })?;
        let spk = script_from_hex(&u.script_pub_key)?;
        let (program, witness_script) = witness_program(u, i)?;
        let pi = &mut psbt.inputs[i];
        if spk == program {
            // native segwit
        } else if spk.is_p2sh() && spk == ScriptBuf::new_p2sh(&program.script_hash()) {
            pi.redeem_script = Some(program);
        } else {
            return Err(PsbtError::ScriptMismatch(i));
        }
        pi.witness_utxo = Some(TxOut {
            value: bitcoin::Amount::from_sat(u.amount.sat()),
            script_pubkey: spk,
        });
        pi.witness_script = witness_script;
    }
    Ok(psbt.serialize().to_lower_hex_string())
}

/// Chain view used to confirm the amounts a caller claims for the inputs it asks us to sign.
pub trait UtxoView {
    fn amount_of(&mut self, txid: &str, vout: u32) -> Option<Amount>;
}

/// Fee of `rawtx` given verified input amounts; fails on unknown inputs, amount mismatches,
/// overspend or a fee above `max_fee`.
pub fn guard_sign(
    rawtx_hex: &str,
    inputs: &[Utxo],
    view: &mut dyn UtxoView,
    max_fee: Amount,
) -> Result<Amount, PsbtError> {
    let tx = decode_tx(rawtx_hex)?;
    let mut total_in = Amount::ZERO;
    for txin in &tx.input {
        let u = find_input(inputs, &txin.previous_output).ok_or_else(|| {
            PsbtError::UnknownInput(
                txin.previous_output.txid.to_string(),
                txin.previous_output.vout,
            )
        })?;
        match view.amount_of(&u.txid.to_ascii_lowercase(), u.vout) {
            Some(a) if a == u.amount => {}
            _ => return Err(PsbtError::AmountMismatch(u.txid.clone(), u.vout)),
        }
        total_in = total_in.checked_add(u.amount)?;
    }
    let total_out = sum_outputs(&tx)?;
    let fee = total_in
        .checked_sub(total_out)
        .map_err(|_| PsbtError::Overspend)?;
    if fee > max_fee {
        return Err(PsbtError::FeeTooHigh {
            fee: fee.sat(),
            max: max_fee.sat(),
        });
    }
    Ok(fee)
}

/// What the seller expects the buyer's trade PSBT to contain.
#[derive(Clone, Debug)]
pub struct TradeTxExpectation {
    /// Commit UTXOs of the channel (both parties'), whose amounts the caller has verified.
    pub channel_inputs: Vec<Utxo>,
    /// Output script of the seller's address (from `validateaddress`).
    pub seller_script_pub_key: String,
    pub seller_min_out: Amount,
    /// Required leading bytes of the OP_RETURN payload (the block-height tail is chosen by the
    /// buyer, so only the prefix is checkable).
    pub payload_prefix: Vec<u8>,
    pub max_fee: Amount,
}

pub fn check_trade_psbt(psbt_hex: &str, exp: &TradeTxExpectation) -> Result<(), PsbtError> {
    let psbt = Psbt::deserialize(&hex_bytes(psbt_hex)?).map_err(|_| PsbtError::BadPsbt)?;
    let tx = &psbt.unsigned_tx;
    if tx.input.is_empty() {
        return Err(PsbtError::NoInputs);
    }
    if tx.output.len() > MAX_OUTPUTS {
        return Err(PsbtError::TooManyOutputs);
    }
    // Every input must carry its witness UTXO so the sighash amounts are explicit.
    let mut total_in: u64 = 0;
    for (i, pi) in psbt.inputs.iter().enumerate() {
        let w = pi
            .witness_utxo
            .as_ref()
            .ok_or(PsbtError::MissingWitnessUtxo(i))?;
        total_in = total_in
            .checked_add(w.value.to_sat())
            .filter(|v| *v <= MAX_MONEY)
            .ok_or(PsbtError::Amount(AmountError::OutOfRange))?;
    }
    for c in &exp.channel_inputs {
        let txid = Txid::from_str(&c.txid).map_err(|_| PsbtError::BadHex)?;
        let idx = tx
            .input
            .iter()
            .position(|i| i.previous_output == OutPoint { txid, vout: c.vout })
            .ok_or_else(|| PsbtError::MissingChannelInput(c.txid.clone(), c.vout))?;
        let w = psbt.inputs[idx]
            .witness_utxo
            .as_ref()
            .ok_or(PsbtError::MissingWitnessUtxo(idx))?;
        if w.value.to_sat() != c.amount.sat()
            || w.script_pubkey != script_from_hex(&c.script_pub_key)?
        {
            return Err(PsbtError::ChannelInputMismatch(c.txid.clone(), c.vout));
        }
    }
    let total_out = sum_outputs(tx)?.sat();
    let fee = total_in
        .checked_sub(total_out)
        .ok_or(PsbtError::Overspend)?;
    if fee > exp.max_fee.sat() {
        return Err(PsbtError::FeeTooHigh {
            fee,
            max: exp.max_fee.sat(),
        });
    }
    // Exactly one data carrier, with the expected prefix.
    let mut carriers = tx.output.iter().filter(|o| o.script_pubkey.is_op_return());
    let carrier = carriers.next().ok_or(PsbtError::PayloadMismatch)?;
    if carriers.next().is_some() {
        return Err(PsbtError::PayloadMismatch);
    }
    let mut data: Option<Vec<u8>> = None;
    for ins in carrier.script_pubkey.instructions().flatten() {
        if let Instruction::PushBytes(p) = ins {
            data = Some(p.as_bytes().to_vec());
            break;
        }
    }
    match data {
        Some(d) if d.starts_with(&exp.payload_prefix) => {}
        _ => return Err(PsbtError::PayloadMismatch),
    }
    let seller_script = script_from_hex(&exp.seller_script_pub_key)?;
    let paid: u64 = tx
        .output
        .iter()
        .filter(|o| o.script_pubkey == seller_script)
        .map(|o| o.value.to_sat())
        .fold(0u64, |a, v| a.saturating_add(v));
    if paid < exp.seller_min_out.sat() {
        return Err(PsbtError::SellerOutputMissing);
    }
    Ok(())
}

/// Helper for tests and callers: serialize a transaction to the node's hex format.
pub fn tx_to_hex(tx: &Transaction) -> String {
    serialize(tx).to_lower_hex_string()
}

/// Helper: txid bytes in node display order from a hex string.
pub fn parse_txid(s: &str) -> Result<Txid, PsbtError> {
    Txid::from_str(s).map_err(|_| PsbtError::BadHex)
}

/// Generic guard for `sign-psbt`: every input carries a witness UTXO whose value matches the
/// chain view, outputs do not exceed inputs and the fee is at most `max_fee`.
pub fn guard_psbt(
    psbt_hex: &str,
    view: &mut dyn UtxoView,
    max_fee: Amount,
) -> Result<Amount, PsbtError> {
    let psbt = Psbt::deserialize(&hex_bytes(psbt_hex)?).map_err(|_| PsbtError::BadPsbt)?;
    let tx = &psbt.unsigned_tx;
    if tx.input.is_empty() {
        return Err(PsbtError::NoInputs);
    }
    if tx.output.len() > MAX_OUTPUTS {
        return Err(PsbtError::TooManyOutputs);
    }
    let mut total_in = Amount::ZERO;
    for (i, txin) in tx.input.iter().enumerate() {
        let w = psbt.inputs[i]
            .witness_utxo
            .as_ref()
            .ok_or(PsbtError::MissingWitnessUtxo(i))?;
        let claimed = Amount::from_sat(w.value.to_sat())?;
        let txid = txin.previous_output.txid.to_string();
        match view.amount_of(&txid, txin.previous_output.vout) {
            Some(a) if a == claimed => {}
            _ => return Err(PsbtError::AmountMismatch(txid, txin.previous_output.vout)),
        }
        total_in = total_in.checked_add(claimed)?;
    }
    let fee = total_in
        .checked_sub(sum_outputs(tx)?)
        .map_err(|_| PsbtError::Overspend)?;
    if fee > max_fee {
        return Err(PsbtError::FeeTooHigh {
            fee: fee.sat(),
            max: max_fee.sat(),
        });
    }
    Ok(fee)
}

pub fn psbt_input_count(psbt_hex: &str) -> Result<usize, PsbtError> {
    let psbt = Psbt::deserialize(&hex_bytes(psbt_hex)?).map_err(|_| PsbtError::BadPsbt)?;
    Ok(psbt.unsigned_tx.input.len())
}
