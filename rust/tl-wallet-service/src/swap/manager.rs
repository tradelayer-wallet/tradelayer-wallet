//! Couples the order book (reservations) with the state machine. A swap can only be created from
//! a trade that names keys the wallet holds, matches a fitting open order and reserves its amount;
//! when the swap ends the reservation is settled or released exactly once.

use super::machine::{Envelope, Kind, Payload, Status, Step, Swap, SwapError, SWAP_TIMEOUT_MS};
use super::order::{OrderBook, Reject};
use super::types::{Role, TradeId, TradeInfo};
use std::collections::{BTreeMap, VecDeque};

pub const MAX_ACTIVE_SWAPS: usize = 16;
const FINISHED_MEMORY: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Settled,
    Aborted,
    TimedOut,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ManagerError {
    Rejected(Reject),
    Swap(SwapError),
    UnknownTrade,
    TooManySwaps,
    /// The trade does not describe a distinct buyer and seller session.
    SameSession,
}

impl From<Reject> for ManagerError {
    fn from(r: Reject) -> ManagerError {
        ManagerError::Rejected(r)
    }
}

impl From<SwapError> for ManagerError {
    fn from(e: SwapError) -> ManagerError {
        ManagerError::Swap(e)
    }
}

impl std::fmt::Display for ManagerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for ManagerError {}

#[derive(Debug, Default)]
pub struct SwapManager {
    pub book: OrderBook,
    active: BTreeMap<TradeId, Swap>,
    finished: VecDeque<(TradeId, Outcome)>,
}

impl SwapManager {
    pub fn new(book: OrderBook) -> SwapManager {
        SwapManager {
            book,
            active: BTreeMap::new(),
            finished: VecDeque::new(),
        }
    }

    pub fn active_count(&self) -> usize {
        self.active.len()
    }

    pub fn outcome(&self, id: &TradeId) -> Option<Outcome> {
        self.finished.iter().find(|(t, _)| t == id).map(|(_, o)| *o)
    }

    pub fn swap(&self, id: &TradeId) -> Option<&Swap> {
        self.active.get(id)
    }

    /// Handle a `new-channel` event: `role` is the wallet's own role (`isBuyer`).
    pub fn start_trade(
        &mut self,
        info: &TradeInfo,
        role: Role,
        now_ms: u64,
    ) -> Result<TradeId, ManagerError> {
        if info.buyer.session == info.seller.session {
            return Err(ManagerError::SameSession);
        }
        if self.active.len() >= MAX_ACTIVE_SWAPS {
            return Err(ManagerError::TooManySwaps);
        }
        let id = info.id();
        if self.active.contains_key(&id) || self.outcome(&id).is_some() {
            return Err(Reject::DuplicateTrade.into());
        }
        self.book.reserve_for(id, info, role)?;
        let me = info.party(role).session.clone();
        let peer = info.party(role.other()).session.clone();
        self.active
            .insert(id, Swap::new(role, id, me, peer, now_ms, SWAP_TIMEOUT_MS));
        Ok(id)
    }

    fn after(&mut self, id: &TradeId) {
        let Some(sw) = self.active.get(id) else {
            return;
        };
        let outcome = match sw.status() {
            Status::Active => return,
            Status::Settled => Outcome::Settled,
            Status::Terminated { .. } => Outcome::Aborted,
            Status::TimedOut => Outcome::TimedOut,
        };
        self.active.remove(id);
        let _ = match outcome {
            Outcome::Settled => self.book.settle(id),
            _ => self.book.release(id),
        };
        self.finished.push_back((*id, outcome));
        while self.finished.len() > FINISHED_MEMORY {
            self.finished.pop_front();
        }
    }

    pub fn receive(&mut self, env: &Envelope, now_ms: u64) -> Result<Kind, ManagerError> {
        let sw = self
            .active
            .get_mut(&env.trade_id)
            .ok_or(ManagerError::UnknownTrade)?;
        let r = sw.receive(env, now_ms);
        self.after(&env.trade_id);
        Ok(r?)
    }

    pub fn send(
        &mut self,
        id: &TradeId,
        step: Step,
        payload: Payload,
        now_ms: u64,
    ) -> Result<Envelope, ManagerError> {
        let sw = self.active.get_mut(id).ok_or(ManagerError::UnknownTrade)?;
        let r = sw.send(step, payload, now_ms);
        self.after(id);
        Ok(r?)
    }

    pub fn terminate(&mut self, id: &TradeId, reason: &str) -> Result<Envelope, ManagerError> {
        let sw = self.active.get_mut(id).ok_or(ManagerError::UnknownTrade)?;
        let r = sw.terminate(reason);
        self.after(id);
        Ok(r?)
    }

    /// Expire overdue swaps and release their reservations.
    pub fn tick(&mut self, now_ms: u64) {
        let ids: Vec<TradeId> = self.active.keys().copied().collect();
        for id in ids {
            if let Some(sw) = self.active.get_mut(&id) {
                sw.tick(now_ms);
            }
            self.after(&id);
        }
    }
}
