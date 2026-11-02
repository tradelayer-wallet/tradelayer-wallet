//! Spot and futures buy/sell cards: order construction, available-balance and maximum-amount
//! maths, fee estimate and form validation, ported from
//! `spot-buy-sell-card.component.ts` and `futures-buy-sell-card.component.ts`
//! (`handleBuySell`, `getMaxAmount`, `getFees`, `getInOrderAmount`, `getTotal`,
//! `getButtonDisabled`). Prices, amounts and balances are `Amount`s (1e-8); the legacy code used JS
//! doubles rounded with `safeNumber` (6 decimals).
//!
//! Conventions (see README "Compatibility table"): an order `amount` is a quantity of the *base*
//! asset (first token), `price` is quote per base. A BUY commits `amount * price` of the quote
//! asset (rounded **up**), a SELL commits `amount` of the base asset. A futures order commits
//! `amount * price` of the collateral token on both sides (leverage 1).
//!
//! Repaired defects (regression tests in `tests/orderform.rs`):
//! * `handleBuySell` never re-checked the balance; only the template disabled the button when
//!   `amount > getMaxAmount`. `build_order` enforces it (Lean `OrderForm.accepts_within_available`).
//! * `getMaxAmount` rounded `available / price` to the *nearest* 6 decimals, so the maximum could
//!   cost more than the balance (0.2 / 0.3 -> 0.666667, cost 0.2000001). Here it is floored and the
//!   cost is rounded up (`maxBuy_affordable`, `maxBuy_maximal`).
//! * the fee inside `getMaxAmount` depends on the amount already typed into the form, so the
//!   "tricky update" in `fillMax` called it twice and still did not reach a fixed point. The
//!   maximum is now the largest amount whose own fee still fits (monotone search).
//! * in-order reservation was `amount * price` for every order; a SELL reserves `amount` of the
//!   base asset, so SELL orders at price != 1 reserved the wrong quantity.
//! * `getFees` counted `amount * price` of LTC for a SELL of LTC (should be `amount`) and, for
//!   futures, treated the collateral amount as LTC to fund (the collateral is a token).
//! * market orders with no price (`currentPrice` 0/undefined) passed the `(!price && isLimit)`
//!   test and were sent with price 0; `max = available / 0 = Infinity` enabled the button.
//! * futures SELL maximum ignored the price (`amount <= available` collateral).
//! * a market with the same property on both sides is refused; more than 8 decimals are refused.
//!
//! Preserved: form minimum 0.01 for price and amount (`Validators.min(0.01)`), the property-id
//! truthiness test (0 is not a tradable id; -1 is LTC), 0.001 LTC reserved per open non-LTC spot
//! order, fee 0.0006 per input with the `0.000036` minimum output and the phantom first entry
//! in the LTC input list (conservative; open question), futures wire name `levarage`.

use crate::amount::{Amount, AmountError, COIN, MAX_MONEY};
use crate::txbuilder::FEE_PER_INPUT_SAT;
use serde_json::{json, Value};

/// Property id of LTC in the legacy services.
pub const LTC_PROPERTY: i64 = -1;
/// `minVOutAmount = 0.000036`.
pub const MIN_VOUT_SAT: u64 = 3_600;
/// `return 0.001` in `getInOrderAmount`: LTC kept back per open non-LTC spot order.
pub const LTC_ORDER_FEE_RESERVE_SAT: u64 = 100_000;
/// `Validators.min(0.01)` on the price and amount controls.
pub const FORM_MIN_SAT: u64 = 1_000_000;
/// Leverage sent by the futures card (the wire key is the legacy typo `levarage`).
pub const FUTURES_LEVERAGE: u64 = 1;
/// Resource bound on UTXOs examined by the fee estimate.
pub const MAX_FEE_UTXOS: usize = 1_000;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn label(self) -> &'static str {
        match self {
            Side::Buy => "BUY",
            Side::Sell => "SELL",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Venue {
    Spot {
        first: i64,
        second: i64,
        pair: String,
    },
    Futures {
        contract_id: i64,
        collateral: i64,
        pair: String,
    },
}

impl Venue {
    /// Property that is paid/locked by `side` (`propIdForSale`; futures: the collateral).
    pub fn for_sale(&self, side: Side) -> i64 {
        match (self, side) {
            (Venue::Spot { second, .. }, Side::Buy) => *second,
            (Venue::Spot { first, .. }, Side::Sell) => *first,
            (Venue::Futures { collateral, .. }, _) => *collateral,
        }
    }

    /// Property that is received (`propIdDesired`); futures have none.
    pub fn desired(&self, side: Side) -> Option<i64> {
        match (self, side) {
            (Venue::Spot { first, .. }, Side::Buy) => Some(*first),
            (Venue::Spot { second, .. }, Side::Sell) => Some(*second),
            (Venue::Futures { .. }, _) => None,
        }
    }

    fn pair(&self) -> &str {
        match self {
            Venue::Spot { pair, .. } | Venue::Futures { pair, .. } => pair,
        }
    }
}

/// An open order of this wallet as the card sees it (`o.props`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenOrder {
    /// `id_for_sale` (spot) or `collateral` (futures).
    pub asset: i64,
    pub side: Side,
    pub amount: Amount,
    pub price: Amount,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Balances {
    /// `getCoinBalancesByAddress().confirmed`.
    pub ltc_confirmed: Amount,
    /// Amounts of the wallet's UTXOs (`.utxos.map(r => r.amount)`).
    pub utxos: Vec<Amount>,
    /// `getTokensBalancesByAddress()` as (propertyid, balance).
    pub tokens: Vec<(i64, Amount)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyRef {
    pub address: String,
    pub pubkey: String,
}

/// Everything a card reads from services.
#[derive(Clone, Debug)]
pub struct CardContext<'a> {
    pub venue: Venue,
    pub key: Option<KeyRef>,
    pub balances: &'a Balances,
    pub open_orders: &'a [OpenOrder],
    /// `attestationService.getAttByAddress(address) === true`.
    pub attested: bool,
    /// `orderbookService.currentPrice` (0/None when the book is empty).
    pub current_price: Option<Amount>,
    pub is_limit: bool,
}

/// The two form controls; `None` is an empty control.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct FormInput {
    pub price: Option<Amount>,
    pub amount: Option<Amount>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrderError {
    /// No key pair for this card: the legacy handler returned silently.
    NoKey,
    /// `You need at least: {fee} LTC for this trade`.
    NeedLtc {
        fee: Amount,
    },
    /// `Address Need Attestation first!`
    NotAttested,
    /// A property id is 0 or a market has the same id on both sides.
    BadMarket,
    BadContract,
    MissingPrice,
    MissingAmount,
    /// price or amount below the form minimum (0.01).
    BelowFormMinimum,
    /// amount * price exceeds what the balance and open orders allow.
    ExceedsAvailable {
        max: Amount,
    },
    Amount(AmountError),
}

impl From<AmountError> for OrderError {
    fn from(e: AmountError) -> OrderError {
        OrderError::Amount(e)
    }
}

impl std::fmt::Display for OrderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OrderError::NoKey => f.write_str("no key pair for this card"),
            OrderError::NeedLtc { fee } => {
                write!(
                    f,
                    "You need at least: {} LTC for this trade",
                    fee.to_coin_string()
                )
            }
            OrderError::NotAttested => f.write_str("Address Need Attestation first!"),
            OrderError::BadMarket => f.write_str("invalid market"),
            OrderError::BadContract => f.write_str("invalid contract"),
            OrderError::MissingPrice => f.write_str("price is required"),
            OrderError::MissingAmount => f.write_str("amount is required"),
            OrderError::BelowFormMinimum => f.write_str("price and amount must be at least 0.01"),
            OrderError::ExceedsAvailable { max } => {
                write!(
                    f,
                    "amount exceeds the available maximum {}",
                    max.to_coin_string()
                )
            }
            OrderError::Amount(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for OrderError {}

/// `ceil(amount * price / 1e8)`: what a BUY (or a futures order) commits. Rounded up so the
/// commitment is never smaller than the exact product.
pub fn cost(amount: Amount, price: Amount) -> Result<Amount, AmountError> {
    let p = amount.sat() as u128 * price.sat() as u128;
    let c = p.div_ceil(COIN as u128);
    let c = u64::try_from(c).map_err(|_| AmountError::OutOfRange)?;
    Amount::from_sat(c)
}

/// `floor(available / price)` in base units: the largest amount whose `cost` fits `available`.
/// A zero price has no maximum and yields zero.
pub fn max_for_budget(available: Amount, price: Amount) -> Amount {
    if price.sat() == 0 {
        return Amount::ZERO;
    }
    let m = available.sat() as u128 * COIN as u128 / price.sat() as u128;
    let m = m.min(MAX_MONEY as u128) as u64;
    Amount::from_sat(m).unwrap_or(Amount::ZERO)
}

/// Quantity of the for-sale asset an order commits.
fn commitment(
    venue: &Venue,
    side: Side,
    amount: Amount,
    price: Amount,
) -> Result<Amount, AmountError> {
    match (venue, side) {
        (Venue::Spot { .. }, Side::Sell) => Ok(amount),
        _ => cost(amount, price),
    }
}

fn reservation(venue: &Venue, o: &OpenOrder) -> Result<Amount, AmountError> {
    commitment(venue, o.side, o.amount, o.price)
}

/// `getInOrderAmount(propertyId)`.
pub fn reserved_in_orders(
    venue: &Venue,
    orders: &[OpenOrder],
    property: i64,
) -> Result<Amount, AmountError> {
    let mut sum = Amount::ZERO;
    for o in orders {
        let part = match venue {
            Venue::Spot { .. } if property == LTC_PROPERTY && o.asset != LTC_PROPERTY => {
                Amount::from_sat(LTC_ORDER_FEE_RESERVE_SAT)?
            }
            _ if o.asset == property => reservation(venue, o)?,
            _ => Amount::ZERO,
        };
        sum = sum.checked_add(part)?;
    }
    Ok(sum)
}

impl Balances {
    /// Balance of `property`. Futures cards read tokens only (LTC collateral reads as zero, as the
    /// legacy `getTokensBalancesByAddress().find(...)` did).
    pub fn of(&self, venue: &Venue, property: i64) -> Amount {
        if property == LTC_PROPERTY && matches!(venue, Venue::Spot { .. }) {
            return self.ltc_confirmed;
        }
        self.tokens
            .iter()
            .find(|(id, _)| *id == property)
            .map(|(_, b)| *b)
            .unwrap_or(Amount::ZERO)
    }
}

/// Balance minus open-order reservations, floored at zero.
pub fn available(ctx: &CardContext<'_>, property: i64) -> Result<Amount, AmountError> {
    let bal = ctx.balances.of(&ctx.venue, property);
    let reserved = reserved_in_orders(&ctx.venue, ctx.open_orders, property)?;
    Amount::from_sat(bal.sat().saturating_sub(reserved.sat()))
}

/// `getFees`: number of inputs the greedy selection needs times 0.0006. The loop mirrors the
/// legacy `forEach`: an input is taken while `sum < target + fee(len + 1)`. For LTC-funded orders
/// the list is prefixed with the legacy phantom entry of `0.000036`.
pub fn fee_estimate(
    venue: &Venue,
    side: Side,
    utxos: &[Amount],
    form: FormInput,
) -> Result<Amount, AmountError> {
    let (amount, price) = match (form.amount, form.price) {
        (Some(a), Some(p)) if a.sat() != 0 && p.sat() != 0 => (a, p),
        _ => return Ok(Amount::ZERO),
    };
    let asset = venue.for_sale(side);
    let spends_ltc = matches!(venue, Venue::Spot { .. }) && asset == LTC_PROPERTY;
    let target = if spends_ltc {
        commitment(venue, side, amount, price)?
            .sat()
            .checked_add(MIN_VOUT_SAT)
            .ok_or(AmountError::OutOfRange)?
    } else {
        MIN_VOUT_SAT * 2
    };
    let mut list: Vec<u64> = utxos.iter().take(MAX_FEE_UTXOS).map(|a| a.sat()).collect();
    list.sort_unstable_by(|a, b| b.cmp(a));
    if spends_ltc {
        list.insert(0, MIN_VOUT_SAT);
    }
    let mut taken = 0u64;
    let mut sum = 0u64;
    for u in list {
        let fee = FEE_PER_INPUT_SAT * (taken + 1);
        if sum < target.saturating_add(fee) {
            sum = sum.saturating_add(u);
            taken += 1;
        }
    }
    Amount::from_sat(FEE_PER_INPUT_SAT * taken)
}

fn effective_price(ctx: &CardContext<'_>, input: FormInput) -> Option<Amount> {
    let p = if ctx.is_limit {
        input.price
    } else {
        ctx.current_price
    };
    p.filter(|p| p.sat() != 0)
}

/// Does `amount` fit the balance (and, for LTC, its own fee)? Returns the shortfall-free answer.
fn fits(
    ctx: &CardContext<'_>,
    side: Side,
    amount: Amount,
    price: Amount,
) -> Result<bool, AmountError> {
    let asset = ctx.venue.for_sale(side);
    let committed = commitment(&ctx.venue, side, amount, price)?;
    let avail = available(ctx, asset)?;
    if matches!(ctx.venue, Venue::Spot { .. }) && asset == LTC_PROPERTY {
        let form = FormInput {
            price: Some(price),
            amount: Some(amount),
        };
        let fee = fee_estimate(&ctx.venue, side, &ctx.balances.utxos, form)?;
        Ok(committed.sat() as u128 + fee.sat() as u128 <= avail.sat() as u128)
    } else {
        Ok(committed <= avail)
    }
}

/// `getMaxAmount`: the largest base-asset amount the card may submit. Zero without a key, without
/// a usable price, or without funds.
pub fn max_amount(
    ctx: &CardContext<'_>,
    side: Side,
    input: FormInput,
) -> Result<Amount, AmountError> {
    if ctx.key.is_none() {
        return Ok(Amount::ZERO);
    }
    let Some(price) = effective_price(ctx, input) else {
        return Ok(Amount::ZERO);
    };
    let asset = ctx.venue.for_sale(side);
    let avail = available(ctx, asset)?;
    let hi = match (&ctx.venue, side) {
        (Venue::Spot { .. }, Side::Sell) => avail,
        _ => max_for_budget(avail, price),
    };
    if !(matches!(ctx.venue, Venue::Spot { .. }) && asset == LTC_PROPERTY) {
        return Ok(hi);
    }
    // LTC pays its own fee, which grows with the amount: `fits` is monotone, so search.
    let (mut lo, mut top) = (0u64, hi.sat());
    while lo < top {
        let mid = lo + (top - lo).div_ceil(2);
        if fits(ctx, side, Amount::from_sat(mid)?, price)? {
            lo = mid;
        } else {
            top = mid - 1;
        }
    }
    Amount::from_sat(lo)
}

/// The form validators: both controls required and at least 0.01.
pub fn form_valid(input: FormInput) -> bool {
    matches!((input.price, input.amount),
        (Some(p), Some(a)) if p.sat() >= FORM_MIN_SAT && a.sat() >= FORM_MIN_SAT)
}

/// `getButtonDisabled`.
pub fn button_disabled(ctx: &CardContext<'_>, side: Side, input: FormInput) -> bool {
    let Some(amount) = input.amount else {
        return true;
    };
    match max_amount(ctx, side, input) {
        Ok(max) => !form_valid(input) || amount > max,
        Err(_) => true,
    }
}

/// `getTotal`: text shown under the form (`toFixed(4)`, decimal half-up on the integer).
pub fn total_display(
    side: Side,
    input: FormInput,
    token_short_name: &str,
) -> Result<String, AmountError> {
    let amount = input.amount.unwrap_or(Amount::ZERO);
    let shown = match side {
        Side::Buy => cost_half_up(amount, input.price.unwrap_or(Amount::ZERO))?,
        Side::Sell => amount,
    };
    let unit = COIN / 10_000;
    let rem = shown.sat() % unit;
    let mut base = shown.sat() - rem;
    if rem * 2 >= unit {
        base += unit;
    }
    Ok(format!(
        "{}.{:04} {}",
        base / COIN,
        (base % COIN) / unit,
        token_short_name
    ))
}

fn cost_half_up(amount: Amount, price: Amount) -> Result<Amount, AmountError> {
    let p = amount.sat() as u128 * price.sat() as u128;
    let c = (p + COIN as u128 / 2) / COIN as u128;
    Amount::from_sat(u64::try_from(c).map_err(|_| AmountError::OutOfRange)?)
}

/// What the card emits on `new-order` (`ISpotTradeConf` / `IFuturesTradeConf`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderRequest {
    pub key: KeyRef,
    pub side: Side,
    pub venue: Venue,
    pub amount: Amount,
    pub price: Amount,
    pub is_limit: bool,
}

impl OrderRequest {
    /// The socket payload in the legacy shape (numbers as JSON numbers, `levarage` as sent).
    pub fn to_json(&self) -> Value {
        let props = match &self.venue {
            Venue::Spot { .. } => json!({
                "id_desired": self.venue.desired(self.side),
                "id_for_sale": self.venue.for_sale(self.side),
                "amount": self.amount.to_json_number(),
                "price": self.price.to_json_number(),
            }),
            Venue::Futures {
                contract_id,
                collateral,
                ..
            } => json!({
                "contract_id": contract_id,
                "amount": self.amount.to_json_number(),
                "price": self.price.to_json_number(),
                "collateral": collateral,
                "levarage": FUTURES_LEVERAGE,
            }),
        };
        json!({
            "keypair": { "address": self.key.address, "pubkey": self.key.pubkey },
            "action": self.side.label(),
            "type": match self.venue { Venue::Spot { .. } => "SPOT", Venue::Futures { .. } => "FUTURES" },
            "props": props,
            "isLimitOrder": self.is_limit,
            "marketName": self.venue.pair(),
        })
    }
}

/// `handleBuySell`, with the balance check the legacy handler left to the template.
pub fn build_order(
    ctx: &CardContext<'_>,
    side: Side,
    input: FormInput,
) -> Result<OrderRequest, OrderError> {
    let fee = fee_estimate(&ctx.venue, side, &ctx.balances.utxos, input)?;
    if ctx.balances.ltc_confirmed < fee {
        return Err(OrderError::NeedLtc { fee });
    }
    if !ctx.attested {
        return Err(OrderError::NotAttested);
    }
    match &ctx.venue {
        Venue::Spot { first, second, .. } => {
            if *first == 0 || *second == 0 || first == second {
                return Err(OrderError::BadMarket);
            }
        }
        Venue::Futures {
            contract_id,
            collateral,
            ..
        } => {
            if *contract_id == 0 {
                return Err(OrderError::BadContract);
            }
            if *collateral == 0 {
                return Err(OrderError::BadMarket);
            }
        }
    }
    let price = effective_price(ctx, input).ok_or(OrderError::MissingPrice)?;
    let amount = input
        .amount
        .filter(|a| a.sat() != 0)
        .ok_or(OrderError::MissingAmount)?;
    if !form_valid(FormInput {
        price: input.price.or(Some(price)),
        amount: Some(amount),
    }) {
        return Err(OrderError::BelowFormMinimum);
    }
    let key = ctx.key.clone().ok_or(OrderError::NoKey)?;
    if !fits(ctx, side, amount, price)? {
        let max = max_amount(ctx, side, input)?;
        return Err(OrderError::ExceedsAvailable { max });
    }
    Ok(OrderRequest {
        key,
        side,
        venue: ctx.venue.clone(),
        amount,
        price,
        is_limit: ctx.is_limit,
    })
}

/// Parse a form control: empty is `None`; anything but a plain decimal with at most 8 places is
/// an error (the legacy number input let `1e-7` and 9-decimal values through to the server).
pub fn parse_control(s: &str) -> Result<Option<Amount>, AmountError> {
    if s.trim().is_empty() {
        return Ok(None);
    }
    Amount::parse_coin(s).map(Some)
}
