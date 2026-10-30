//! UTXO selection, fee and change planning, ported from
//! `packages/wallet-server/src/services/tx-builder.service.ts` (`buildTx`, `buildLTCInstatTx`,
//! `getEnoughInputs`, `getEnoughInputs2`). All values are integer base units (`Amount`).
//!
//! Preserved: fee = 0.3 * 0.002 coin per selected input (`FEE_PER_INPUT_SAT`), caller-supplied
//! inputs are considered before the wallet's own UTXOs, wallet UTXOs are considered largest first,
//! the recipient floor `min_out` (node's reference-output amount), the "Minimum amount" rejection.
//!
//! Repaired defects (each has a regression test in `tests/txbuilder.rs`):
//! * payload txs charged the fee twice when `amount > min + fee` (`tx-builder.service.ts:137-139`);
//! * negative change was silently dropped, producing an under-funded fee (`:139-145`);
//! * fee-aware selection demanded the fee of one input more than it used (`getEnoughInputs2`
//!   priced `length + 1`), so it always over-selected one input and paid for it;
//! * the guard `inputsSum < fee + toAmount + change` could never fire (`:141`); conservation is now
//!   exact and checked (`Plan::check_conservation`);
//! * amounts below `min + fee` were silently clamped up to `min` so the fee was under-paid;
//! * duplicate outpoints in `inputs` + `listunspent` were counted twice (`:100`, `:41`);
//! * mandatory commit UTXOs were dropped once earlier inputs already covered the target
//!   (`getEnoughInputs2` forEach, `:200-206`), yielding an instant-trade tx that cannot settle;
//! * recipient == sender collapsed two outputs into one JS object key and lost an amount
//!   (`:124-125`); the Rust plan merges equal addresses.

use crate::amount::{Amount, AmountError};
use std::collections::BTreeSet;

/// 0.3 * 0.002 coin = 0.0006 coin per input.
pub const FEE_PER_INPUT_SAT: u64 = 60_000;
/// Resource bound on selected inputs.
pub const MAX_INPUTS: usize = 100;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Utxo {
    pub txid: String,
    pub vout: u32,
    pub amount: Amount,
    pub confirmations: u32,
    pub script_pub_key: String,
    pub redeem_script: Option<String>,
    pub pubkey: Option<String>,
}

impl Utxo {
    pub fn outpoint(&self) -> (&str, u32) {
        (self.txid.as_str(), self.vout)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlanError {
    NoInputs,
    TooManyInputs,
    InsufficientFunds,
    /// Requested amount is below the node's minimum output and there is no payload.
    BelowMinimum {
        min: Amount,
    },
    /// Recipient pays the fee but `amount - fee` is below the minimum output.
    AmountTooSmallForFee,
    Amount(AmountError),
}

impl From<AmountError> for PlanError {
    fn from(e: AmountError) -> PlanError {
        PlanError::Amount(e)
    }
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::NoInputs => f.write_str("Not enough coins for paying fees (no inputs)"),
            PlanError::TooManyInputs => f.write_str("too many inputs required"),
            PlanError::InsufficientFunds => f.write_str("Not enough coins for paying fees"),
            PlanError::BelowMinimum { min } => {
                write!(f, "Minimum amount is: {}", min.to_coin_string())
            }
            PlanError::AmountTooSmallForFee => f.write_str("amount too small to cover the fee"),
            PlanError::Amount(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for PlanError {}

pub fn fee_for_inputs(n: usize) -> Result<Amount, PlanError> {
    Ok(Amount::from_sat(FEE_PER_INPUT_SAT)?.checked_mul(n as u64)?)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeePayer {
    /// No payload: the recipient receives `amount - fee`, change is `inputs - amount`.
    Recipient,
    /// Payload present: the recipient receives `amount`, change is `inputs - amount - fee`.
    Sender,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub inputs: Vec<Utxo>,
    /// Output to the recipient (always `>= min_out`).
    pub to_amount: Amount,
    /// Change back to the sender; zero means no change output.
    pub change: Amount,
    pub fee: Amount,
}

impl Plan {
    pub fn input_sum(&self) -> Result<Amount, AmountError> {
        self.inputs
            .iter()
            .try_fold(Amount::ZERO, |a, u| a.checked_add(u.amount))
    }

    /// `inputs == to + change + fee` and `fee == FEE_PER_INPUT * |inputs|`.
    pub fn check_conservation(&self) -> bool {
        let Ok(sum) = self.input_sum() else {
            return false;
        };
        let Ok(out) = self
            .to_amount
            .checked_add(self.change)
            .and_then(|o| o.checked_add(self.fee))
        else {
            return false;
        };
        sum == out && fee_for_inputs(self.inputs.len()).is_ok_and(|f| f == self.fee)
    }
}

/// Order: caller-supplied inputs first, then wallet UTXOs by amount descending (stable); the first
/// occurrence of an outpoint wins.
pub fn candidate_order(supplied: &[Utxo], wallet: &[Utxo]) -> Vec<Utxo> {
    let mut w: Vec<Utxo> = wallet.to_vec();
    w.sort_by_key(|u| std::cmp::Reverse(u.amount));
    dedup_outpoints(supplied.iter().chain(w.iter()))
}

fn dedup_outpoints<'a>(it: impl Iterator<Item = &'a Utxo>) -> Vec<Utxo> {
    let mut seen: BTreeSet<(String, u32)> = BTreeSet::new();
    let mut out = Vec::new();
    for u in it {
        if seen.insert((u.txid.clone(), u.vout)) {
            out.push(u.clone());
        }
    }
    out
}

fn sum(inputs: &[Utxo]) -> Result<Amount, PlanError> {
    Ok(inputs
        .iter()
        .try_fold(Amount::ZERO, |a, u| a.checked_add(u.amount))?)
}

/// Greedy selection: add the next candidate while the running sum is below `target + fee(n)` for the
/// `n` inputs chosen so far (fee-aware) or below `target` (legacy `getEnoughInputs`).
fn select(
    candidates: &[Utxo],
    mandatory: usize,
    target: Amount,
    fee_aware: bool,
) -> Result<Vec<Utxo>, PlanError> {
    let mut chosen: Vec<Utxo> = Vec::new();
    for (i, u) in candidates.iter().enumerate() {
        let must = i < mandatory;
        if !must {
            let have = sum(&chosen)?;
            let need = if fee_aware {
                target.checked_add(fee_for_inputs(chosen.len())?)?
            } else {
                target
            };
            if have >= need {
                break;
            }
        }
        chosen.push(u.clone());
        if chosen.len() > MAX_INPUTS {
            return Err(PlanError::TooManyInputs);
        }
    }
    Ok(chosen)
}

pub struct PaymentRequest<'a> {
    /// `amount` of the HTTP body; `None` means "just the minimum output" (payload carriers).
    pub amount: Option<Amount>,
    pub has_payload: bool,
    /// Node reference-output amount (`tl_createrawtx_reference` -> `decoderawtransaction` vout[0]).
    pub min_out: Amount,
    pub supplied: &'a [Utxo],
    pub wallet: &'a [Utxo],
}

/// Port of `buildTx`'s amount arithmetic.
pub fn plan_payment(req: &PaymentRequest<'_>) -> Result<Plan, PlanError> {
    if let Some(a) = req.amount {
        if req.min_out > a && !req.has_payload {
            return Err(PlanError::BelowMinimum { min: req.min_out });
        }
    }
    let amount = req.amount.unwrap_or(Amount::ZERO).max(req.min_out);
    let candidates = candidate_order(req.supplied, req.wallet);
    let fee_payer = if req.has_payload {
        FeePayer::Sender
    } else {
        FeePayer::Recipient
    };
    let inputs = select(&candidates, 0, amount, fee_payer == FeePayer::Sender)?;
    if inputs.is_empty() {
        return Err(PlanError::NoInputs);
    }
    let fee = fee_for_inputs(inputs.len())?;
    let total = sum(&inputs)?;
    let (to_amount, change) = match fee_payer {
        FeePayer::Recipient => {
            let to = amount
                .checked_sub(fee)
                .map_err(|_| PlanError::AmountTooSmallForFee)?;
            if to < req.min_out {
                return Err(PlanError::AmountTooSmallForFee);
            }
            let change = total
                .checked_sub(amount)
                .map_err(|_| PlanError::InsufficientFunds)?;
            (to, change)
        }
        FeePayer::Sender => {
            let need = amount.checked_add(fee)?;
            let change = total
                .checked_sub(need)
                .map_err(|_| PlanError::InsufficientFunds)?;
            (amount, change)
        }
    };
    let plan = Plan {
        inputs,
        to_amount,
        change,
        fee,
    };
    if plan.check_conservation() {
        Ok(plan)
    } else {
        Err(PlanError::InsufficientFunds)
    }
}

pub struct InstantTradeRequest<'a> {
    /// Seller's LTC leg (`amount`); the seller output is `max(amount, min_out)`.
    pub amount: Amount,
    pub min_out: Amount,
    /// Channel commit UTXOs: all are mandatory inputs.
    pub commit_utxos: &'a [Utxo],
    pub wallet: &'a [Utxo],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstantPlan {
    pub inputs: Vec<Utxo>,
    pub seller_amount: Amount,
    pub buyer_change: Amount,
    pub fee: Amount,
}

impl InstantPlan {
    pub fn check_conservation(&self) -> bool {
        let Ok(total) = self
            .inputs
            .iter()
            .try_fold(Amount::ZERO, |a, u| a.checked_add(u.amount))
        else {
            return false;
        };
        let Ok(out) = self
            .seller_amount
            .checked_add(self.buyer_change)
            .and_then(|o| o.checked_add(self.fee))
        else {
            return false;
        };
        total == out && fee_for_inputs(self.inputs.len()).is_ok_and(|f| f == self.fee)
    }
}

/// Port of `buildLTCInstatTx`'s amount arithmetic.
pub fn plan_instant_trade(req: &InstantTradeRequest<'_>) -> Result<InstantPlan, PlanError> {
    let mandatory = dedup_outpoints(req.commit_utxos.iter());
    let mut wallet: Vec<Utxo> = req.wallet.to_vec();
    wallet.sort_by_key(|u| std::cmp::Reverse(u.amount));
    let mut seen: BTreeSet<(String, u32)> =
        mandatory.iter().map(|u| (u.txid.clone(), u.vout)).collect();
    let extras: Vec<Utxo> = wallet
        .into_iter()
        .filter(|u| seen.insert((u.txid.clone(), u.vout)))
        .collect();
    let candidates: Vec<Utxo> = mandatory.iter().cloned().chain(extras).collect();

    let buyer_min = req.min_out;
    let seller_amount = req.amount.max(req.min_out);
    let target = buyer_min.checked_add(seller_amount)?;
    let inputs = select(&candidates, mandatory.len(), target, true)?;
    if inputs.is_empty() {
        return Err(PlanError::NoInputs);
    }
    let fee = fee_for_inputs(inputs.len())?;
    let total = sum(&inputs)?;
    let spare = total
        .checked_sub(seller_amount)
        .and_then(|v| v.checked_sub(fee));
    let buyer_change = match spare {
        Ok(s) if s > buyer_min => s,
        _ => buyer_min,
    };
    // Legacy guard `inputsSum < fee + seller + change` (this one is effective here).
    let need = fee
        .checked_add(seller_amount)
        .and_then(|v| v.checked_add(buyer_change))?;
    if total < need {
        return Err(PlanError::InsufficientFunds);
    }
    let plan = InstantPlan {
        inputs,
        seller_amount,
        buyer_change,
        fee,
    };
    if plan.check_conservation() {
        Ok(plan)
    } else {
        Err(PlanError::InsufficientFunds)
    }
}

/// `createrawtransaction` output list. Equal addresses are merged (legacy object keys collided).
pub fn merged_outputs(outs: &[(String, Amount)]) -> Result<Vec<(String, Amount)>, AmountError> {
    let mut merged: Vec<(String, Amount)> = Vec::new();
    for (addr, amt) in outs {
        if amt.sat() == 0 {
            continue;
        }
        match merged.iter_mut().find(|(a, _)| a == addr) {
            Some((_, v)) => *v = v.checked_add(*amt)?,
            None => merged.push((addr.clone(), *amt)),
        }
    }
    Ok(merged)
}
