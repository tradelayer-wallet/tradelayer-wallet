//! Transaction forms of the wallet front end, without UI or RPC transport:
//!
//! * `@pages/tx-builder-page/build-tab` (`payload_call`): the `tl_createpayload_*` parameter list,
//! * `@shared/dialogs/tx-builder/tx-types/{send-ltc,send-token,send-vesting,send-activation}`
//!   (`SendTx`, `send_request`): the `tradeData` objects and the address-check state,
//! * `@shared/dialogs/withdraw` (`withdraw_request`, `withdraw_max`),
//! * `@shared/dialogs/new-multisig` and the multisig stepper of `tx-builder/tabs/sign`
//!   (`Stepper`, `MultisigForm`),
//! * `sign-tab` input handling (`vins_from_decoded`, `check_raw_tx`, `detail_complete`).
//!
//! Key handling is not here: the sign tabs hand a WIF/private key to `signrawtransaction`, which
//! stays behind the `SignBackend` boundary (see README "Not ported").
//!
//! Repaired defects (regression tests in `tests/txforms.rs`):
//! * integer controls were `parseFloat`ed: `1.5`, `abc` (NaN -> JSON null) and negative ids reached
//!   the node; amounts were `value.toString()` of a JS number, which prints exponents (`1e-7`) the
//!   node rejects. Ids are strict positive integers, amounts decimals of at most 8 places, sent
//!   without exponent (`build-tab.component.ts:93-96`);
//! * zero and negative amounts passed `Validators.required` (page build tab);
//! * the send dialogs enabled the Build button while the recipient was still unchecked
//!   (`isAddressValid === null`), and a missing `isvalid` field left the state `undefined`, also
//!   enabled; the withdraw dialog's `validateAddress` body is commented out, so the recipient was
//!   never validated at all. Building now requires a positive check (`AddressCheck::Valid`);
//! * `validateAddress` read `error.message` when only `data` was empty, throwing a `TypeError`
//!   (`send-ltc.tx-type.component.ts:57`); `parse_validateaddress` is total;
//! * `changeKeyType` kept the previous pubkey when switching to HARDWARE/SERVER, and nothing could
//!   enter a pubkey for those types (`new-multisig.component.ts:99-107,89-92`); pubkeys were never
//!   checked for validity or uniqueness (`:75`);
//! * the sign tab mapped a coinbase input (no `txid`) to `{txid: undefined}`
//!   (`sign-tab.component.ts:71`).
//!
//! Preserved: withdraw minimum 0.001, withdraw maximum = confirmed LTC (a plain send takes the fee
//! out of the amount, see `txbuilder::FeePayer::Recipient`), property id 0 is not a valid id,
//! multisig 2..=7 keys with `nRequired` in `2..=nAllKeys`, one HOT key at most.

use crate::amount::{Amount, AmountError};
use bitcoin::secp256k1::PublicKey;
use serde_json::{json, Value};
use std::str::FromStr;

/// `Validators.min` equivalent of the withdraw dialog (`amount < 0.001`).
pub const WITHDRAW_MIN_SAT: u64 = 100_000;
pub const MULTISIG_MIN_KEYS: usize = 2;
pub const MULTISIG_MAX_KEYS: usize = 7;
/// Largest raw transaction accepted by the sign tab (hex characters).
pub const MAX_RAW_TX_HEX: usize = 800_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FormError {
    FieldCount,
    Missing(&'static str),
    NotAnId(&'static str),
    Amount(AmountError),
    NotPositive,
    SameAddress,
    AddressNotValidated,
    BelowMinimum,
    AboveMaximum,
    BadHex,
    TooLarge,
    Decode,
    Coinbase,
    Multisig(MultisigError),
}

impl From<AmountError> for FormError {
    fn from(e: AmountError) -> FormError {
        FormError::Amount(e)
    }
}

impl From<MultisigError> for FormError {
    fn from(e: MultisigError) -> FormError {
        FormError::Multisig(e)
    }
}

impl std::fmt::Display for FormError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FormError::FieldCount => f.write_str("wrong number of fields"),
            FormError::Missing(n) => write!(f, "{n} is required"),
            FormError::NotAnId(n) => write!(f, "{n} must be a positive integer"),
            FormError::Amount(e) => write!(f, "{e}"),
            FormError::NotPositive => f.write_str("amount must be greater than zero"),
            FormError::SameAddress => f.write_str("Both addresses are the same"),
            FormError::AddressNotValidated => f.write_str("recipient address is not validated"),
            FormError::BelowMinimum => f.write_str("amount below the minimum"),
            FormError::AboveMaximum => f.write_str("amount above the available balance"),
            FormError::BadHex => f.write_str("not a hex string"),
            FormError::TooLarge => f.write_str("transaction too large"),
            FormError::Decode => f.write_str("undecodable transaction"),
            FormError::Coinbase => f.write_str("coinbase input cannot be signed"),
            FormError::Multisig(e) => write!(f, "{e:?}"),
        }
    }
}

impl std::error::Error for FormError {}

// ---------------------------------------------------------------------------------------------
// payload parameters (page build tab)

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum PayloadKind {
    Attestation,
    SimpleSend,
    SendVesting,
    SendActivation,
}

impl PayloadKind {
    pub fn rpc(self) -> &'static str {
        match self {
            PayloadKind::Attestation => "tl_createpayload_attestation",
            PayloadKind::SimpleSend => "tl_createpayload_simplesend",
            PayloadKind::SendVesting => "tl_createpayload_sendvesting",
            PayloadKind::SendActivation => "tl_createpayload_sendactivation",
        }
    }

    /// (field name, is an amount string) in RPC parameter order.
    fn fields(self) -> &'static [(&'static str, bool)] {
        match self {
            PayloadKind::Attestation => &[],
            PayloadKind::SimpleSend => &[("prop_id", false), ("amount", true)],
            PayloadKind::SendVesting => &[("amount", true)],
            PayloadKind::SendActivation => &[
                ("featureid", false),
                ("block", false),
                ("minclientversion", false),
            ],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RpcCall {
    pub method: &'static str,
    pub params: Vec<Value>,
}

/// A strictly positive 32-bit integer (property, feature and block numbers).
pub fn parse_id(name: &'static str, s: &str) -> Result<u32, FormError> {
    let s = s.trim();
    if s.is_empty() {
        return Err(FormError::Missing(name));
    }
    if !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(FormError::NotAnId(name));
    }
    match s.parse::<u32>() {
        Ok(v) if v > 0 => Ok(v),
        _ => Err(FormError::NotAnId(name)),
    }
}

/// A strictly positive amount.
pub fn parse_positive_amount(name: &'static str, s: &str) -> Result<Amount, FormError> {
    if s.trim().is_empty() {
        return Err(FormError::Missing(name));
    }
    let a = Amount::parse_coin(s)?;
    if a.sat() == 0 {
        return Err(FormError::NotPositive);
    }
    Ok(a)
}

/// Decimal text without exponent and without trailing zeros (`1.5`, `10`), the form a JS number
/// prints in the ordinary range.
pub fn amount_text(a: Amount) -> String {
    let s = a.to_coin_string();
    let t = s.trim_end_matches('0').trim_end_matches('.');
    if t.is_empty() {
        "0".to_string()
    } else {
        t.to_string()
    }
}

/// The RPC call the build tab makes for `kind` with the raw form `fields` in order.
pub fn payload_call(kind: PayloadKind, fields: &[&str]) -> Result<RpcCall, FormError> {
    let spec = kind.fields();
    if fields.len() != spec.len() {
        return Err(FormError::FieldCount);
    }
    let mut params = Vec::with_capacity(spec.len());
    for ((name, is_amount), raw) in spec.iter().zip(fields) {
        if *is_amount {
            params.push(Value::String(amount_text(parse_positive_amount(
                name, raw,
            )?)));
        } else {
            params.push(json!(parse_id(name, raw)?));
        }
    }
    Ok(RpcCall {
        method: kind.rpc(),
        params,
    })
}

// ---------------------------------------------------------------------------------------------
// address check state (send dialogs, withdraw)

/// `isAddressValid: boolean | null | 'PENDING'`.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum AddressCheck {
    Unchecked,
    Pending,
    Valid,
    Invalid,
}

impl AddressCheck {
    /// The setter of `toAddress` resets the state.
    pub fn edited(self) -> AddressCheck {
        AddressCheck::Unchecked
    }

    /// Legacy `buttonDisabled` part: only an explicit `false` or `'PENDING'` blocked the button.
    pub fn legacy_blocks_button(self) -> bool {
        matches!(self, AddressCheck::Pending | AddressCheck::Invalid)
    }

    pub fn allows_build(self) -> bool {
        self == AddressCheck::Valid
    }
}

/// Result of `validateaddress`: valid only for `{"isvalid": true}`; anything else is invalid.
pub fn parse_validateaddress(result: Option<&Value>) -> AddressCheck {
    match result
        .and_then(|v| v.get("isvalid"))
        .and_then(Value::as_bool)
    {
        Some(true) => AddressCheck::Valid,
        _ => AddressCheck::Invalid,
    }
}

// ---------------------------------------------------------------------------------------------
// send dialogs

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendTx {
    Ltc {
        amount: String,
    },
    Token {
        amount: String,
        prop_id: String,
    },
    Vesting {
        amount: String,
    },
    Activation {
        feature_id: String,
        block: String,
        min_client_version: String,
    },
}

/// `tradeData` handed to the (absent in this snapshot) `BuilderService.build`.
pub fn send_request(
    sender: &str,
    to: &str,
    to_check: AddressCheck,
    tx: &SendTx,
) -> Result<Value, FormError> {
    if sender.trim().is_empty() {
        return Err(FormError::Missing("sender"));
    }
    if to.trim().is_empty() {
        return Err(FormError::Missing("toAddress"));
    }
    if !to_check.allows_build() {
        return Err(FormError::AddressNotValidated);
    }
    let mut v = json!({ "fromAddress": sender, "toAddress": to });
    let obj = v.as_object_mut().ok_or(FormError::Decode)?;
    match tx {
        SendTx::Ltc { amount } => {
            obj.insert(
                "amount".into(),
                parse_positive_amount("amount", amount)?.to_json_number(),
            );
            obj.insert("txType".into(), json!("SEND_LTC"));
        }
        SendTx::Token { amount, prop_id } => {
            obj.insert(
                "amount".into(),
                parse_positive_amount("amount", amount)?.to_json_number(),
            );
            obj.insert("txType".into(), json!("SEND_TOKEN"));
            obj.insert("propId".into(), json!(parse_id("propId", prop_id)?));
        }
        SendTx::Vesting { amount } => {
            obj.insert(
                "amount".into(),
                parse_positive_amount("amount", amount)?.to_json_number(),
            );
            obj.insert("txType".into(), json!("SEND_VESTING"));
        }
        SendTx::Activation {
            feature_id,
            block,
            min_client_version,
        } => {
            obj.insert(
                "featureid".into(),
                json!(parse_id("featureid", feature_id)?),
            );
            obj.insert("block".into(), json!(parse_id("block", block)?));
            obj.insert(
                "minclientversion".into(),
                json!(parse_id("minclientversion", min_client_version)?),
            );
            obj.insert("txType".into(), json!("SEND_ACTIVATION"));
        }
    }
    Ok(v)
}

// ---------------------------------------------------------------------------------------------
// withdraw dialog

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WithdrawTx {
    /// `IBuildTxConfig { fromKeyPair, toKeyPair, amount }`.
    Ltc {
        from: String,
        to: String,
        amount: Amount,
    },
    /// `tl_createpayload_simplesend [propId, amount]` followed by a payload transaction.
    Token {
        from: String,
        to: String,
        payload_call: RpcCall,
    },
}

/// Maximum offered by `fillAmountInput`: confirmed LTC, or the token balance (zero if absent).
pub fn withdraw_max(prop_id: i64, ltc_confirmed: Amount, tokens: &[(i64, Amount)]) -> Amount {
    if prop_id == -1 {
        return ltc_confirmed;
    }
    tokens
        .iter()
        .find(|(id, _)| *id == prop_id)
        .map(|(_, b)| *b)
        .unwrap_or(Amount::ZERO)
}

/// `buttonDisabled` + `withdraw()` + `getTxOptions`.
pub fn withdraw_request(
    from: &str,
    to: &str,
    to_check: AddressCheck,
    prop_id: i64,
    amount: &str,
    max: Amount,
) -> Result<WithdrawTx, FormError> {
    if from.trim().is_empty() {
        return Err(FormError::Missing("fromAddress"));
    }
    if to.trim().is_empty() {
        return Err(FormError::Missing("toAddress"));
    }
    if from == to {
        return Err(FormError::SameAddress);
    }
    if prop_id == 0 || prop_id < -1 {
        return Err(FormError::NotAnId("propId"));
    }
    if !to_check.allows_build() {
        return Err(FormError::AddressNotValidated);
    }
    let amount = parse_positive_amount("amount", amount)?;
    if amount.sat() < WITHDRAW_MIN_SAT {
        return Err(FormError::BelowMinimum);
    }
    if amount > max {
        return Err(FormError::AboveMaximum);
    }
    if prop_id == -1 {
        return Ok(WithdrawTx::Ltc {
            from: from.to_string(),
            to: to.to_string(),
            amount,
        });
    }
    Ok(WithdrawTx::Token {
        from: from.to_string(),
        to: to.to_string(),
        payload_call: RpcCall {
            method: PayloadKind::SimpleSend.rpc(),
            params: vec![json!(prop_id), Value::String(amount_text(amount))],
        },
    })
}

// ---------------------------------------------------------------------------------------------
// multisig

/// The `nKeysChange` stepper shared by the multisig dialog and the sign tab.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Stepper {
    pub n_required: usize,
    pub n_all: usize,
}

impl Default for Stepper {
    fn default() -> Stepper {
        Stepper {
            n_required: MULTISIG_MIN_KEYS,
            n_all: MULTISIG_MIN_KEYS,
        }
    }
}

impl Stepper {
    /// Invariant: `2 <= n_required <= n_all <= 7`.
    pub fn invariant(&self) -> bool {
        MULTISIG_MIN_KEYS <= self.n_required
            && self.n_required <= self.n_all
            && self.n_all <= MULTISIG_MAX_KEYS
    }

    pub fn required_up(&mut self) {
        if self.n_required < self.n_all {
            self.n_required += 1;
        }
    }

    pub fn required_down(&mut self) {
        if self.n_required > MULTISIG_MIN_KEYS {
            self.n_required -= 1;
        }
    }

    /// Returns whether a key slot was added.
    pub fn all_up(&mut self) -> bool {
        if self.n_all < MULTISIG_MAX_KEYS {
            self.n_all += 1;
            true
        } else {
            false
        }
    }

    /// Returns whether the last key slot was removed.
    pub fn all_down(&mut self) -> bool {
        if self.n_all > MULTISIG_MIN_KEYS {
            self.n_all -= 1;
            if self.n_required > self.n_all {
                self.n_required = self.n_all;
            }
            true
        } else {
            false
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum KeyType {
    Hot,
    Airgap,
    Hardware,
    Server,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeySlot {
    pub ty: Option<KeyType>,
    pub pubkey: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MultisigError {
    NoSuchSlot,
    SecondHotKey,
    NoHotKeyAvailable,
    PubkeyNotEditable,
    BadPubkey(usize),
    DuplicatePubkey,
}

#[derive(Clone, Debug)]
pub struct MultisigForm {
    pub stepper: Stepper,
    pub slots: Vec<KeySlot>,
    /// `authService.activeMainKey.pubkey`, used by a HOT slot.
    hot_pubkey: Option<String>,
}

impl MultisigForm {
    pub fn new(hot_pubkey: Option<String>) -> MultisigForm {
        let stepper = Stepper::default();
        MultisigForm {
            stepper,
            slots: vec![KeySlot::default(); stepper.n_all],
            hot_pubkey,
        }
    }

    pub fn add_key(&mut self) {
        if self.stepper.all_up() {
            self.slots.push(KeySlot::default());
        }
    }

    pub fn remove_key(&mut self) {
        if self.stepper.all_down() {
            self.slots.pop();
        }
    }

    /// `changeKeyType`: at most one HOT slot (re-selecting HOT on the HOT slot is refused, as
    /// legacy did). Repaired: every type change clears the previous pubkey, except HOT which takes
    /// the active main key.
    pub fn set_type(&mut self, index: usize, ty: KeyType) -> Result<(), MultisigError> {
        if index >= self.slots.len() {
            return Err(MultisigError::NoSuchSlot);
        }
        if ty == KeyType::Hot {
            if self.slots.iter().any(|s| s.ty == Some(KeyType::Hot)) {
                return Err(MultisigError::SecondHotKey);
            }
            let hot = self
                .hot_pubkey
                .clone()
                .ok_or(MultisigError::NoHotKeyAvailable)?;
            self.slots[index] = KeySlot {
                ty: Some(ty),
                pubkey: hot,
            };
        } else {
            self.slots[index] = KeySlot {
                ty: Some(ty),
                pubkey: String::new(),
            };
        }
        Ok(())
    }

    /// `changePubKey`: legacy edited AIRGAP slots only; HARDWARE and SERVER slots have no other
    /// way to receive a key and are editable here. The HOT slot's key is fixed.
    pub fn set_pubkey(&mut self, index: usize, pubkey: &str) -> Result<(), MultisigError> {
        let slot = self.slots.get_mut(index).ok_or(MultisigError::NoSuchSlot)?;
        match slot.ty {
            Some(KeyType::Airgap) | Some(KeyType::Hardware) | Some(KeyType::Server) => {
                slot.pubkey = pubkey.trim().to_string();
                Ok(())
            }
            _ => Err(MultisigError::PubkeyNotEditable),
        }
    }

    /// Legacy `buttonDisabled` is `!keys.every(k => k.pubkey)`.
    pub fn legacy_button_disabled(&self) -> bool {
        !self.slots.iter().all(|s| !s.pubkey.is_empty())
    }

    /// Every slot holds a distinct valid compressed secp256k1 public key.
    pub fn validate(&self) -> Result<Vec<String>, MultisigError> {
        let mut keys: Vec<String> = Vec::with_capacity(self.slots.len());
        for (i, s) in self.slots.iter().enumerate() {
            if !is_compressed_pubkey(&s.pubkey) {
                return Err(MultisigError::BadPubkey(i));
            }
            let k = s.pubkey.to_ascii_lowercase();
            if keys.contains(&k) {
                return Err(MultisigError::DuplicatePubkey);
            }
            keys.push(k);
        }
        Ok(keys)
    }

    /// `addmultisigaddress [nRequired, pubkeys]` (the commented-out `create()`).
    pub fn create_call(&self) -> Result<RpcCall, MultisigError> {
        let keys = self.validate()?;
        Ok(RpcCall {
            method: "addmultisigaddress",
            params: vec![json!(self.stepper.n_required), json!(keys)],
        })
    }
}

/// 33-byte compressed key on the curve, in hex.
pub fn is_compressed_pubkey(s: &str) -> bool {
    s.len() == 66 && s.bytes().all(|b| b.is_ascii_hexdigit()) && PublicKey::from_str(s).is_ok()
}

// ---------------------------------------------------------------------------------------------
// sign tab

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Vin {
    pub txid: String,
    pub vout: u32,
}

/// Hex of a raw transaction pasted into the sign tab (the legacy test was `!rawTx`).
pub fn check_raw_tx(hex: &str) -> Result<(), FormError> {
    let h = hex.trim();
    if h.is_empty() || !h.len().is_multiple_of(2) || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(FormError::BadHex);
    }
    if h.len() > MAX_RAW_TX_HEX {
        return Err(FormError::TooLarge);
    }
    Ok(())
}

/// `decoderawtransaction` result -> `[{txid, vout}]`.
pub fn vins_from_decoded(decoded: &Value) -> Result<Vec<Vin>, FormError> {
    let vin = decoded
        .get("vin")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or(FormError::Decode)?;
    vin.iter()
        .map(|i| {
            if i.get("coinbase").is_some() {
                return Err(FormError::Coinbase);
            }
            let txid = i
                .get("txid")
                .and_then(Value::as_str)
                .filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or(FormError::Decode)?;
            let vout = i
                .get("vout")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
                .ok_or(FormError::Decode)?;
            Ok(Vin {
                txid: txid.to_ascii_lowercase(),
                vout,
            })
        })
        .collect()
}

/// One row of the "detailed" signing view.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DetailVin {
    pub txid: String,
    pub vout: Option<u32>,
    pub redeem_script: String,
    pub script_pub_key: String,
    pub amount: Option<Amount>,
}

/// Legacy detailed `buttonDisabled` negated: `redeemScript && amount && scriptPubKey && txid &&
/// (vout || vout === 0)`. A zero amount is incomplete, as in JS.
pub fn detail_complete(rows: &[DetailVin]) -> bool {
    !rows.is_empty()
        && rows.iter().all(|r| {
            !r.redeem_script.is_empty()
                && r.amount.is_some_and(|a| a.sat() != 0)
                && !r.script_pub_key.is_empty()
                && !r.txid.is_empty()
                && r.vout.is_some()
        })
}
