//! Pure order/price/balance helpers from the Angular services, without UI or sockets:
//! `spot-orderbook.service.ts` / `futures-orderbook.service.ts` (`_structureOrderbook`, last trade
//! price, history side) and `balance.service.ts` (`getCoinBalanceObjForAddress`).
//!
//! JS doubles are replaced by integers. Prices are `Amount`s scaled by 1e8. Rounding is
//! decimal round-half-up on the integer (JS `toFixed` rounds the binary double, which can differ
//! on exact ties such as 0.00005).

use crate::amount::{Amount, AmountError, COIN};
use crate::txbuilder::Utxo;

/// Depth levels shown per side (`slice(0, 9)`).
pub const DEPTH_LEVELS: usize = 9;
/// `range = 1000`: prices are grouped by their first three decimals.
const BUCKET_UNIT_SAT: u64 = COIN / 1000;
/// `toFixed(4)`.
const DISPLAY_UNIT_SAT: u64 = COIN / 10_000;
/// `toFixed(6)`.
const LAST_PRICE_UNIT_SAT: u64 = COIN / 1_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookOrder {
    pub price: Amount,
    pub amount: Amount,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Level {
    pub price: Amount,
    pub amount: Amount,
}

fn round_half_up(v: u64, unit: u64) -> u64 {
    let rem = v % unit;
    let base = v - rem;
    if rem * 2 >= unit {
        base + unit
    } else {
        base
    }
}

/// Group orders whose prices share the same truncated third decimal; the level shows the first
/// order's price rounded to 4 decimals and the summed amount. Legacy compared the *rounded* stored
/// price against the raw price of later orders, so e.g. 0.00099 and 0.00099 could land in different
/// levels; here the grouping key is always the raw price.
pub fn aggregate(orders: &[BookOrder]) -> Result<Vec<Level>, AmountError> {
    let mut keyed: Vec<(u64, Level)> = Vec::new();
    for o in orders {
        let key = o.price.sat() / BUCKET_UNIT_SAT;
        match keyed.iter_mut().find(|(k, _)| *k == key) {
            Some((_, lvl)) => lvl.amount = lvl.amount.checked_add(o.amount)?,
            None => {
                let shown = Amount::from_sat(round_half_up(o.price.sat(), DISPLAY_UNIT_SAT))?;
                keyed.push((
                    key,
                    Level {
                        price: shown,
                        amount: o.amount,
                    },
                ));
            }
        }
    }
    Ok(keyed.into_iter().map(|(_, l)| l).collect())
}

fn sorted_desc(mut levels: Vec<Level>) -> Vec<Level> {
    levels.sort_by_key(|l| std::cmp::Reverse(l.price));
    levels
}

/// Best (highest) nine buy levels, descending.
pub fn buy_side(levels: Vec<Level>) -> Vec<Level> {
    sorted_desc(levels).into_iter().take(DEPTH_LEVELS).collect()
}

/// Best (lowest) nine sell levels, still ordered descending as the UI shows them.
pub fn sell_side(levels: Vec<Level>) -> Vec<Level> {
    let s = sorted_desc(levels);
    let skip = s.len().saturating_sub(DEPTH_LEVELS);
    s.into_iter().skip(skip).collect()
}

/// Lowest ask, or `fallback` when the sell side is empty (`lastPrice`).
pub fn best_ask(sell_levels: &[Level], fallback: Amount) -> Amount {
    sell_levels
        .iter()
        .map(|l| l.price)
        .min()
        .filter(|p| p.sat() != 0)
        .unwrap_or(fallback)
}

/// `parseFloat((amountForSale / amountDesired).toFixed(6)) || 1`, with the divide-by-zero case
/// (JS `Infinity`) mapped to 1 as well.
pub fn spot_trade_price(amount_for_sale: Amount, amount_desired: Amount) -> Amount {
    let one = Amount::from_sat(COIN).unwrap_or(Amount::ZERO);
    if amount_desired.sat() == 0 {
        return one;
    }
    let p = amount_for_sale.sat() as u128 * COIN as u128 / amount_desired.sat() as u128;
    let Ok(p) = u64::try_from(p) else {
        return one;
    };
    match Amount::from_sat(round_half_up(p, LAST_PRICE_UNIT_SAT)) {
        Ok(a) if a.sat() != 0 => a,
        _ => one,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TradeSide {
    Buy,
    Sell,
}

/// `relatedHistoryTrades`: a trade belongs to the wallet if it is the buyer or the seller address,
/// and the side is `BUY` when the wallet's address is the buyer's.
pub fn history_side(my_address: &str, buyer: &str, seller: &str) -> Option<TradeSide> {
    if my_address.is_empty() {
        return None;
    }
    if buyer == my_address {
        Some(TradeSide::Buy)
    } else if seller == my_address {
        Some(TradeSide::Sell)
    } else {
        None
    }
}

/// `getCoinBalanceObjForAddress`: split UTXOs by `confirmations >= min_conf` (1 in the UI).
pub fn coin_balance(utxos: &[Utxo], min_conf: u32) -> Result<(Amount, Amount), AmountError> {
    let mut confirmed = Amount::ZERO;
    let mut unconfirmed = Amount::ZERO;
    for u in utxos {
        if u.confirmations >= min_conf {
            confirmed = confirmed.checked_add(u.amount)?;
        } else {
            unconfirmed = unconfirmed.checked_add(u.amount)?;
        }
    }
    Ok((confirmed, unconfirmed))
}
