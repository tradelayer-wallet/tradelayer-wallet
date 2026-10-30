//! The wallet's own open orders and the amount reservation that guards the swap handshake.
//!
//! Legacy: `swap.service.ts` started a `BuySwapper`/`SellSwapper` for any `new-channel` event the
//! orderbook relayed, using whatever keys and amounts the event named. The open PR #47 in the TS
//! code base closes this; this module is the Rust equivalent: a swap may start only if
//!  * the wallet holds the named key pair (address + pubkey),
//!  * a fitting open order exists (same key pair, side, market, limit price respected),
//!  * the order's unreserved remainder covers the trade amount, which is then reserved.
//!
//! A reservation is released on abort/timeout and consumed on settlement.
//!
//! Semantic assumption (unresolved with `tl-orderbook-server`): an order's `amount` is measured in
//! the base asset, i.e. the amount the buyer desires (spot) or the contract count (futures), and
//! `limit` is quote-per-base scaled by 1e8.

use super::types::{KeyPair, Role, TradeId, TradeInfo, TradeKind};
use crate::amount::{Amount, COIN};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_OPEN_ORDERS: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn role(self) -> Role {
        match self {
            Side::Buy => Role::Buyer,
            Side::Sell => Role::Seller,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrderMarket {
    /// `id_desired`/`id_for_sale` as stored on the order, i.e. from the order owner's view.
    Spot {
        id_desired: i64,
        id_for_sale: i64,
    },
    Futures {
        contract_id: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderTerms {
    pub uuid: String,
    pub keypair: KeyPair,
    pub side: Side,
    pub market: OrderMarket,
    /// Limit price (quote per base, 1e8 scale); `None` is a market order.
    pub limit: Option<Amount>,
    /// Total base amount still open (reserved part included).
    pub amount: Amount,
    /// Futures only: maximum collateral the owner is willing to commit per trade.
    pub max_collateral: Option<Amount>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reject {
    /// The wallet does not hold the named address/pubkey pair.
    KeyNotHeld,
    /// The counterparty claims one of our own keys.
    SelfTrade,
    NoFittingOrder,
    PriceOutsideLimit,
    InsufficientUnreserved,
    DuplicateTrade,
    DuplicateOrder,
    UnknownTrade,
    OrderBusy,
    BookFull,
    BadTerms,
}

#[derive(Clone, Debug)]
struct Entry {
    terms: OrderTerms,
    reserved: Amount,
}

#[derive(Clone, Debug, Default)]
pub struct OrderBook {
    held: BTreeSet<KeyPair>,
    orders: BTreeMap<String, Entry>,
    reservations: BTreeMap<TradeId, (String, Amount)>,
}

/// `quote * 1e8 <= limit * base` (buyer) / `>=` (seller), in u128 so nothing overflows.
fn price_ok(side: Side, quote: Amount, base: Amount, limit: Amount) -> bool {
    let lhs = quote.sat() as u128 * COIN as u128;
    let rhs = limit.sat() as u128 * base.sat() as u128;
    match side {
        Side::Buy => lhs <= rhs,
        Side::Sell => lhs >= rhs,
    }
}

impl OrderBook {
    pub fn new() -> OrderBook {
        OrderBook::default()
    }

    pub fn hold_key(&mut self, kp: KeyPair) {
        self.held.insert(kp);
    }

    pub fn holds(&self, kp: &KeyPair) -> bool {
        self.held.contains(kp)
    }

    pub fn add_order(&mut self, terms: OrderTerms) -> Result<(), Reject> {
        if !self.held.contains(&terms.keypair) {
            return Err(Reject::KeyNotHeld);
        }
        if terms.amount == Amount::ZERO || terms.uuid.is_empty() || terms.uuid.len() > 128 {
            return Err(Reject::BadTerms);
        }
        if self.orders.contains_key(&terms.uuid) {
            return Err(Reject::DuplicateOrder);
        }
        if self.orders.len() >= MAX_OPEN_ORDERS {
            return Err(Reject::BookFull);
        }
        self.orders.insert(
            terms.uuid.clone(),
            Entry {
                terms,
                reserved: Amount::ZERO,
            },
        );
        Ok(())
    }

    /// An order with an in-flight swap cannot be closed from under it.
    pub fn cancel_order(&mut self, uuid: &str) -> Result<(), Reject> {
        match self.orders.get(uuid) {
            None => Err(Reject::NoFittingOrder),
            Some(e) if e.reserved != Amount::ZERO => Err(Reject::OrderBusy),
            Some(_) => {
                self.orders.remove(uuid);
                Ok(())
            }
        }
    }

    pub fn open_amount(&self, uuid: &str) -> Option<Amount> {
        self.orders.get(uuid).map(|e| e.terms.amount)
    }

    pub fn reserved_amount(&self, uuid: &str) -> Option<Amount> {
        self.orders.get(uuid).map(|e| e.reserved)
    }

    pub fn available(&self, uuid: &str) -> Option<Amount> {
        let e = self.orders.get(uuid)?;
        e.terms.amount.checked_sub(e.reserved).ok()
    }

    /// Does the order's market describe this trade from `role`'s point of view?
    fn market_matches(m: &OrderMarket, info: &TradeInfo, role: Role) -> bool {
        match (m, &info.kind) {
            (
                OrderMarket::Spot {
                    id_desired,
                    id_for_sale,
                },
                TradeKind::Spot(s),
            ) => match role {
                Role::Buyer => {
                    *id_desired == s.prop_id_desired && *id_for_sale == s.prop_id_for_sale
                }
                Role::Seller => {
                    *id_desired == s.prop_id_for_sale && *id_for_sale == s.prop_id_desired
                }
            },
            (OrderMarket::Futures { contract_id }, TradeKind::Futures(f)) => {
                *contract_id == f.contract_id
            }
            _ => false,
        }
    }

    fn trade_price_ok(t: &OrderTerms, info: &TradeInfo) -> bool {
        let Some(limit) = t.limit else {
            return true;
        };
        match &info.kind {
            TradeKind::Spot(s) => price_ok(t.side, s.amount_for_sale, s.amount_desired, limit),
            TradeKind::Futures(f) => price_ok(t.side, f.price, one_unit(), limit),
        }
    }

    /// Find the order that justifies `info` for the wallet's `role`, without reserving.
    pub fn find_fit(&self, info: &TradeInfo, role: Role) -> Result<String, Reject> {
        let mine = &info.party(role).keypair;
        let theirs = &info.party(role.other()).keypair;
        if !self.held.contains(mine) {
            return Err(Reject::KeyNotHeld);
        }
        if self.held.contains(theirs) {
            return Err(Reject::SelfTrade);
        }
        let base = info.base_amount();
        let mut saw_candidate = false;
        let mut saw_price_ok = false;
        for e in self.orders.values() {
            let t = &e.terms;
            if t.keypair != *mine
                || t.side.role() != role
                || !OrderBook::market_matches(&t.market, info, role)
            {
                continue;
            }
            saw_candidate = true;
            if !OrderBook::trade_price_ok(t, info) {
                continue;
            }
            if let (TradeKind::Futures(f), Some(maxc)) = (&info.kind, t.max_collateral) {
                if f.collateral > maxc {
                    continue;
                }
            }
            saw_price_ok = true;
            let free = t.amount.checked_sub(e.reserved).unwrap_or(Amount::ZERO);
            if base <= free && base != Amount::ZERO {
                return Ok(t.uuid.clone());
            }
        }
        Err(if !saw_candidate {
            Reject::NoFittingOrder
        } else if !saw_price_ok {
            Reject::PriceOutsideLimit
        } else {
            Reject::InsufficientUnreserved
        })
    }

    /// Find a fitting order and reserve the trade's base amount on it.
    pub fn reserve_for(
        &mut self,
        trade: TradeId,
        info: &TradeInfo,
        role: Role,
    ) -> Result<String, Reject> {
        if self.reservations.contains_key(&trade) {
            return Err(Reject::DuplicateTrade);
        }
        let uuid = self.find_fit(info, role)?;
        let base = info.base_amount();
        let e = self.orders.get_mut(&uuid).ok_or(Reject::NoFittingOrder)?;
        e.reserved = e
            .reserved
            .checked_add(base)
            .map_err(|_| Reject::InsufficientUnreserved)?;
        self.reservations.insert(trade, (uuid.clone(), base));
        Ok(uuid)
    }

    /// Abort or timeout: give the amount back.
    pub fn release(&mut self, trade: &TradeId) -> Result<(), Reject> {
        let (uuid, amt) = self
            .reservations
            .remove(trade)
            .ok_or(Reject::UnknownTrade)?;
        if let Some(e) = self.orders.get_mut(&uuid) {
            e.reserved = e.reserved.checked_sub(amt).unwrap_or(Amount::ZERO);
        }
        Ok(())
    }

    /// Settlement: the reserved amount is filled; the order shrinks by it and closes at zero.
    pub fn settle(&mut self, trade: &TradeId) -> Result<(), Reject> {
        let (uuid, amt) = self
            .reservations
            .remove(trade)
            .ok_or(Reject::UnknownTrade)?;
        if let Some(e) = self.orders.get_mut(&uuid) {
            e.reserved = e.reserved.checked_sub(amt).unwrap_or(Amount::ZERO);
            e.terms.amount = e.terms.amount.checked_sub(amt).unwrap_or(Amount::ZERO);
            if e.terms.amount == Amount::ZERO {
                self.orders.remove(&uuid);
            }
        }
        Ok(())
    }

    pub fn reservation_count(&self) -> usize {
        self.reservations.len()
    }

    /// Invariant used by tests and the Lean model: for every order `reserved <= amount`, and the
    /// per-order reserved total equals the sum of its reservations.
    pub fn invariant_holds(&self) -> bool {
        self.orders.values().all(|e| {
            let sum: u64 = self
                .reservations
                .values()
                .filter(|(u, _)| *u == e.terms.uuid)
                .map(|(_, a)| a.sat())
                .sum();
            e.reserved <= e.terms.amount && e.reserved.sat() == sum
        })
    }
}

/// Futures prices are per contract; one contract is one whole unit in the price comparison.
fn one_unit() -> Amount {
    Amount::from_sat(COIN).unwrap_or(Amount::ZERO)
}
