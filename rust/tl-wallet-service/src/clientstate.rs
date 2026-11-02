//! Client-side state logic of the Angular services that is more than RPC pass-through:
//! `attestation.service.ts`, `futures-positions.service.ts`, `{spot,futures}-channels.service.ts`,
//! `node-reward.service.ts`, the sync state of `rpc.service.ts` and the address-list / active-key
//! selection of `auth.service.ts` (no keys, no signing). Transports and toasts are closures or
//! plain return values.
//!
//! Repaired defects (regression tests in `tests/clientstate.rs`):
//! * `checkWinners` re-entered itself after every RPC error (unbounded retry of a failing node) and
//!   after every claim (while `tl_isaddresswinner` still answered `true` the same address was
//!   claimed again before the first claim confirmed) (`node-reward.service.ts:95-118`). A round
//!   now claims each address at most once and retries a failing check a bounded number of times;
//! * `getAddressesFromWallet` recursed without bound after `createwallet` (`auth.service.ts:149-182`);
//! * `checkAttAddress` reported failures with `error.messagokee`, so the toast read `undefined`
//!   (`attestation.service.ts:50`); the message is built from the real error;
//! * `parseFloat` on RPC strings turned malformed positions, commit amounts and property ids into
//!   `NaN` that flowed into balances and the UI (`futures-positions.service.ts:66`,
//!   `*-channels.service.ts:48-49`); malformed values are typed errors;
//! * `rpc.service.ts` `isSynced` yielded a number, `false` or `0`; here a boolean.
//!
//! Preserved: the `tl_check_kyc` result key `result: ` (with the trailing space) and value
//! `enabled(kyc_0)`, the `address:` key (with the colon) of `tl_listnodereward_addresses`, the
//! reward payloads `007900` / `007A00`, `lastBlock + 1 >= headerBlock` as the sync test, a
//! pending attestation counting as "not attested", active key = explicit choice else first key.

use crate::amount::{Amount, AmountError};
use serde_json::Value;

// ---------------------------------------------------------------------------------------------
// attestation

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Att {
    No,
    Yes,
    Pending,
}

#[derive(Clone, Debug, Default)]
pub struct AttestationBook {
    entries: Vec<(String, Att)>,
}

/// `aRes.data['result: '] === 'enabled(kyc_0)'`.
pub fn parse_kyc(data: &Value) -> bool {
    data.get("result: ").and_then(Value::as_str) == Some("enabled(kyc_0)")
}

/// The toast text of a failed check (legacy read `error.messagokee`).
pub fn attestation_error_text(address: &str, error: Option<&str>) -> String {
    format!(
        "Checking Attestations Error, Address: {address}: {}",
        error.filter(|e| !e.is_empty()).unwrap_or("unknown error")
    )
}

impl AttestationBook {
    pub fn remove_all(&mut self) {
        self.entries.clear();
    }

    /// `getAttByAddress(...) === true`.
    pub fn is_attested(&self, address: &str) -> bool {
        self.state(address) == Some(Att::Yes)
    }

    pub fn state(&self, address: &str) -> Option<Att> {
        self.entries
            .iter()
            .find(|(a, _)| a == address)
            .map(|(_, s)| *s)
    }

    /// Addresses of the wallet not yet in the book (`checkAllAtt`), in wallet order, once each.
    pub fn unchecked<'a>(&self, wallet: &'a [String]) -> Vec<&'a str> {
        let mut out: Vec<&str> = Vec::new();
        for a in wallet {
            if self.state(a).is_none() && !out.contains(&a.as_str()) {
                out.push(a);
            }
        }
        out
    }

    pub fn resolve(&mut self, address: &str, attested: bool) {
        let s = if attested { Att::Yes } else { Att::No };
        match self.entries.iter_mut().find(|(a, _)| a == address) {
            Some(e) => e.1 = s,
            None => self.entries.push((address.to_string(), s)),
        }
    }

    pub fn set_pending(&mut self, address: &str) {
        if let Some(e) = self.entries.iter_mut().find(|(a, _)| a == address) {
            e.1 = Att::Pending;
        }
    }

    pub fn pending(&self) -> Vec<&str> {
        self.entries
            .iter()
            .filter(|(_, s)| *s == Att::Pending)
            .map(|(a, _)| a.as_str())
            .collect()
    }
}

// ---------------------------------------------------------------------------------------------
// positions and channel commits

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StateError {
    Malformed(&'static str),
    Amount(AmountError),
}

impl From<AmountError> for StateError {
    fn from(e: AmountError) -> StateError {
        StateError::Amount(e)
    }
}

/// A JSON string or number as decimal text.
fn text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Signed decimal with at most 8 places, in base units.
pub fn parse_signed(s: &str) -> Result<i64, StateError> {
    let (neg, body) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let a = Amount::parse_coin(body)?;
    let v = i64::try_from(a.sat()).map_err(|_| AmountError::OutOfRange)?;
    Ok(if neg { -v } else { v })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Position {
    pub entry_price: String,
    pub position: String,
    pub bankruptcy_price: String,
    pub position_margin: String,
    pub upnl: String,
    /// Signed size in base units (negative: short).
    pub size_sat: i64,
}

/// `tl_getfullposition` -> the open position, or `None` when the size is zero or absent
/// (`parseFloat(data.position || "0")` was falsy).
pub fn parse_position(data: &Value) -> Result<Option<Position>, StateError> {
    let raw = match data.get("position") {
        None | Some(Value::Null) => return Ok(None),
        Some(v) => text(v).ok_or(StateError::Malformed("position"))?,
    };
    if raw.is_empty() {
        return Ok(None);
    }
    let size = parse_signed(&raw)?;
    if size == 0 {
        return Ok(None);
    }
    let field = |k: &'static str| -> String { data.get(k).and_then(text).unwrap_or_default() };
    Ok(Some(Position {
        entry_price: field("entry_price"),
        position: raw,
        bankruptcy_price: field("BANKRUPTCY_PRICE"),
        position_margin: field("position_margin"),
        upnl: field("upnl"),
        size_sat: size,
    }))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelCommit {
    pub amount: Amount,
    pub block: u64,
    pub channel: String,
    pub property_id: i64,
    pub sender: String,
}

/// `tl_check_commits` result -> commits (token names are looked up by the caller).
pub fn parse_commits(data: &Value) -> Result<Vec<ChannelCommit>, StateError> {
    let list = data.as_array().ok_or(StateError::Malformed("commits"))?;
    list.iter()
        .map(|q| {
            let amount = Amount::parse_coin(
                &q.get("amount")
                    .and_then(text)
                    .ok_or(StateError::Malformed("amount"))?,
            )?;
            let property_id = text(
                q.get("propertyId")
                    .ok_or(StateError::Malformed("propertyId"))?,
            )
            .and_then(|s| s.parse::<i64>().ok())
            .ok_or(StateError::Malformed("propertyId"))?;
            let block = q
                .get("block")
                .and_then(Value::as_u64)
                .ok_or(StateError::Malformed("block"))?;
            let s = |k: &'static str| {
                q.get(k)
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or(StateError::Malformed(k))
            };
            Ok(ChannelCommit {
                amount,
                block,
                channel: s("channel")?,
                property_id,
                sender: s("sender")?,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// node reward

pub const REWARD_REGISTER_PAYLOAD: &str = "007900";
pub const REWARD_CLAIM_PAYLOAD: &str = "007A00";
/// Failed `tl_isaddresswinner` checks tolerated per address in one round.
pub const MAX_CHECK_RETRIES: u32 = 3;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Registration {
    Unknown,
    Pending,
    Registered,
    NotRegistered,
}

#[derive(Clone, Debug)]
pub struct RewardAddress {
    pub address: String,
    pub registration: Registration,
    pub auto_claim: bool,
}

/// `tl_listnodereward_addresses` -> registered addresses (the key is `address:`).
pub fn parse_registered(data: &Value) -> Result<Vec<String>, StateError> {
    data.as_array()
        .ok_or(StateError::Malformed("nodereward addresses"))?
        .iter()
        .map(|e| {
            e.get("address:")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or(StateError::Malformed("address:"))
        })
        .collect()
}

/// `checkRegisteredAddresses`: pendings are kept unless `clean_pendings`.
pub fn update_registration(
    addresses: &mut [RewardAddress],
    registered: &[String],
    clean_pendings: bool,
) {
    for a in addresses {
        if clean_pendings || a.registration != Registration::Pending {
            a.registration = if registered.contains(&a.address) {
                Registration::Registered
            } else {
                Registration::NotRegistered
            };
        }
    }
}

/// Result of `tl_isaddresswinner`: `data.result === 'true'`.
pub fn parse_winner(data: &Value) -> bool {
    data.get("result").and_then(Value::as_str) == Some("true")
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClaimReport {
    pub claimed: Vec<String>,
    pub claim_failed: Vec<String>,
    pub check_failed: Vec<String>,
    pub check_retries: u32,
}

/// `checkWinners`: for every auto-claim address ask whether it won and claim once.
/// `is_winner` and `claim` are the RPC/tx calls (`Err` is their error text).
pub fn claim_round<W, C>(addresses: &[RewardAddress], mut is_winner: W, mut claim: C) -> ClaimReport
where
    W: FnMut(&str) -> Result<bool, String>,
    C: FnMut(&str) -> Result<(), String>,
{
    let mut report = ClaimReport::default();
    for a in addresses.iter().filter(|a| a.auto_claim) {
        let mut attempts = 0;
        let won = loop {
            match is_winner(&a.address) {
                Ok(w) => break Some(w),
                Err(_) if attempts < MAX_CHECK_RETRIES => {
                    attempts += 1;
                    report.check_retries += 1;
                }
                Err(_) => break None,
            }
        };
        match won {
            None => report.check_failed.push(a.address.clone()),
            Some(false) => {}
            Some(true) => match claim(&a.address) {
                Ok(()) => report.claimed.push(a.address.clone()),
                Err(_) => report.claim_failed.push(a.address.clone()),
            },
        }
    }
    report
}

// ---------------------------------------------------------------------------------------------
// sync state (rpc.service.ts)

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncState {
    pub is_core_started: bool,
    pub is_able_to_rpc: bool,
    pub last_block: u64,
    pub header_block: u64,
    pub network_blocks: u64,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BlockSource {
    Local,
    Api,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct BlockEvent {
    pub source: BlockSource,
    pub block: u64,
    pub header: u64,
}

impl SyncState {
    /// `isAbleToRpc && headerBlock && lastBlock + 1 >= headerBlock`.
    pub fn is_synced(&self) -> bool {
        self.is_able_to_rpc && self.header_block > 0 && self.last_block + 1 >= self.header_block
    }

    /// socket `new-block`.
    pub fn on_new_block(&mut self, height: u64, header: u64) -> BlockEvent {
        self.last_block = height;
        self.header_block = header;
        BlockEvent {
            source: BlockSource::Local,
            block: height,
            header,
        }
    }

    /// `core-error` / stop: `clearRpcConnection`.
    pub fn clear(&mut self) {
        self.is_able_to_rpc = false;
        self.is_core_started = false;
        self.last_block = 0;
    }

    /// `checkNetworkInfo`: an event only for a new non-zero block count.
    pub fn on_network_info(&mut self, info: &Value) -> Option<BlockEvent> {
        let block = info
            .get("block")
            .and_then(Value::as_u64)
            .filter(|b| *b != 0)?;
        if block == self.network_blocks {
            return None;
        }
        self.network_blocks = block;
        Some(BlockEvent {
            source: BlockSource::Api,
            block,
            header: info.get("headers").and_then(Value::as_u64).unwrap_or(0),
        })
    }
}

// ---------------------------------------------------------------------------------------------
// auth: address list and active key

#[derive(Clone, Debug, Default)]
pub struct WalletKeys {
    pub main: Vec<String>,
    pub spot: Vec<String>,
    pub futures: Vec<String>,
    pub reward: Vec<String>,
    pub liquidity: Vec<String>,
}

impl WalletKeys {
    /// `listOfallAddresses`: `Object.values(walletKeys).flat()` in declaration order.
    pub fn all_addresses(&self) -> Vec<&str> {
        [
            &self.main,
            &self.spot,
            &self.futures,
            &self.reward,
            &self.liquidity,
        ]
        .into_iter()
        .flatten()
        .map(String::as_str)
        .collect()
    }

    /// `isLoggedIn`.
    pub fn is_logged_in(&self) -> bool {
        !self.main.is_empty()
    }
}

/// `activeSpotKey` / `activeFuturesKey` / `activeMainKey`: the explicit choice if it is still one
/// of `list`, else the first entry.
pub fn active_key<'a>(chosen: Option<&'a str>, list: &'a [String]) -> Option<&'a str> {
    match chosen {
        Some(c) if list.iter().any(|a| a == c) => Some(c),
        _ => list.first().map(String::as_str),
    }
}

/// How `getAddressesFromWallet` reacts to a `getaddressesbylabel` answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AddressesOutcome {
    Addresses(Vec<String>),
    /// EECode -11: the label has no addresses.
    Empty,
    /// EECode -18: no wallet loaded; create and load one, then ask again.
    CreateWallet,
    Failed(String),
}

pub fn classify_addresses(
    ee_code: Option<i64>,
    data: Option<&Value>,
    error: Option<&str>,
) -> AddressesOutcome {
    match ee_code {
        Some(-18) => AddressesOutcome::CreateWallet,
        Some(-11) => AddressesOutcome::Empty,
        _ => match (data.and_then(Value::as_object), error) {
            (Some(o), None) => AddressesOutcome::Addresses(o.keys().cloned().collect()),
            (_, e) => AddressesOutcome::Failed(
                e.unwrap_or("getaddressesbylabel: Error with getting addresses")
                    .to_string(),
            ),
        },
    }
}

/// `getAddressesFromWallet` with the create-wallet recursion bounded to one attempt.
/// `ask` performs `getaddressesbylabel`; `create` performs `createwallet` + `loadwallet`.
pub fn fetch_wallet_addresses<A, C>(mut ask: A, mut create: C) -> Result<Vec<String>, String>
where
    A: FnMut() -> AddressesOutcome,
    C: FnMut() -> Result<(), String>,
{
    let mut created = false;
    loop {
        match ask() {
            AddressesOutcome::Addresses(a) => return Ok(a),
            AddressesOutcome::Empty => return Ok(Vec::new()),
            AddressesOutcome::Failed(e) => return Err(e),
            AddressesOutcome::CreateWallet => {
                if created {
                    return Err("wallet still missing after createwallet".to_string());
                }
                created = true;
                create()?;
            }
        }
    }
}
