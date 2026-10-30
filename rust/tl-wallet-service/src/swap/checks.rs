//! Payload-level checks the legacy handlers skipped.
//!
//! * Buyer step 1 (`buyer.ts:onStep1`): legacy compared only the redeem script and then used the
//!   seller-supplied channel *address* for its own commit transaction. A seller could present its
//!   own address with the right redeem script and receive the buyer's commit. The buyer must use
//!   the address and scriptPubKey from its own `addmultisigaddress`/`validateaddress` calls.
//! * Buyer step 3 (`buyer.ts:onStep3`): the seller's commit UTXO was used as an input without
//!   checking that it pays the agreed channel.

use super::machine::{ChannelData, CommitUtxo};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckError {
    RedeemScriptMismatch,
    AddressMismatch,
    ScriptPubKeyMismatch,
    CommitNotToChannel,
    CommitZeroAmount,
}

impl std::fmt::Display for CheckError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for CheckError {}

/// `local` is what this wallet derived itself for the pubkey pair `[seller, buyer]`. The returned
/// value is `local`: only locally derived channel data is ever used afterwards.
pub fn check_multisig_offer(
    local: &ChannelData,
    offered: &ChannelData,
) -> Result<ChannelData, CheckError> {
    if !local
        .redeem_script
        .eq_ignore_ascii_case(&offered.redeem_script)
    {
        return Err(CheckError::RedeemScriptMismatch);
    }
    if local.address != offered.address {
        return Err(CheckError::AddressMismatch);
    }
    if let (Some(l), Some(o)) = (&local.script_pub_key, &offered.script_pub_key) {
        if !l.eq_ignore_ascii_case(o) {
            return Err(CheckError::ScriptPubKeyMismatch);
        }
    }
    Ok(local.clone())
}

pub fn check_commit_utxo(commit: &CommitUtxo, channel: &ChannelData) -> Result<(), CheckError> {
    if commit.amount.sat() == 0 {
        return Err(CheckError::CommitZeroAmount);
    }
    let spk_ok = channel
        .script_pub_key
        .as_deref()
        .is_some_and(|s| s.eq_ignore_ascii_case(&commit.script_pub_key));
    if !spk_ok
        || !commit
            .redeem_script
            .eq_ignore_ascii_case(&channel.redeem_script)
    {
        return Err(CheckError::CommitNotToChannel);
    }
    Ok(())
}
