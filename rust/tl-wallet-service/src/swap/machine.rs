//! Channel-swap protocol state machine. Pure and sans-IO: the caller performs RPC calls and
//! network I/O, feeds peer envelopes to `receive`, and obtains outgoing envelopes from `send`.
//!
//! Protocol (ported from `utils/swapper/seller.ts` and `buyer.ts`; odd steps are the seller's,
//! even steps the buyer's):
//!
//! ```text
//! 1 SELLER:STEP1  multisig channel data      4 BUYER:STEP4   trade PSBT
//! 2 BUYER:STEP2   ack (redeemScript matches) 5 SELLER:STEP5  PSBT signed by seller
//! 3 SELLER:STEP3  seller's commit UTXO       6 BUYER:STEP6   broadcast txid -> settled
//! ```
//! plus `TERMINATE_TRADE` from either side and a 60 s whole-trade timeout (`swap.ts:20`).
//!
//! Differences from the legacy event handlers (all "repaired defect" or "protocol change"):
//! * every envelope carries the trade id and the digest of the transcript so far, so a step is
//!   accepted only for this trade, from the bound counterparty session, as the next step, and
//!   after exactly the previous accepted step (legacy: only a self-asserted `socketId`);
//! * out-of-order, replayed or skipped steps are rejected (legacy `switch` ran any handler at any
//!   time, e.g. a repeated `SELLER:STEP3` re-ran the buyer's whole commit flow);
//! * nothing is accepted after settle, terminate or timeout;
//! * `Settled` is reached only after all six steps.

use super::types::{Role, SessionId, TradeId};
use crate::amount::Amount;
use bitcoin::hashes::{sha256, Hash};

pub const SWAP_TIMEOUT_MS: u64 = 60_000;
pub const MAX_REASON_BYTES: usize = 256;
pub const MAX_PSBT_CHARS: usize = 400_000;
const MAX_SCRIPT_CHARS: usize = 8_192;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    MultisigOffer = 1,
    MultisigAck = 2,
    CommitUtxo = 3,
    TradePsbt = 4,
    SignedPsbt = 5,
    Final = 6,
}

impl Step {
    pub fn number(self) -> u8 {
        self as u8
    }

    pub fn from_number(n: u8) -> Option<Step> {
        Some(match n {
            1 => Step::MultisigOffer,
            2 => Step::MultisigAck,
            3 => Step::CommitUtxo,
            4 => Step::TradePsbt,
            5 => Step::SignedPsbt,
            6 => Step::Final,
            _ => return None,
        })
    }

    /// Which role transmits this step.
    pub fn sender(self) -> Role {
        if self.number() % 2 == 1 {
            Role::Seller
        } else {
            Role::Buyer
        }
    }

    /// Legacy `SwapEvent.eventName`.
    pub fn event_name(self) -> String {
        let who = match self.sender() {
            Role::Seller => "SELLER",
            Role::Buyer => "BUYER",
        };
        format!("{who}:STEP{}", self.number())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelData {
    pub address: String,
    pub redeem_script: String,
    pub script_pub_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitUtxo {
    pub txid: String,
    pub vout: u32,
    pub amount: Amount,
    pub script_pub_key: String,
    pub redeem_script: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Payload {
    MultisigOffer(ChannelData),
    Ack,
    Commit(CommitUtxo),
    /// Step 4 (unsigned/partially built) or step 5 (seller-signed) PSBT, hex.
    Psbt(String),
    Final(String),
    Terminate(String),
}

fn is_hex(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.len().is_multiple_of(2) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

impl Payload {
    fn shape_matches(&self, step: Step) -> bool {
        matches!(
            (self, step),
            (Payload::MultisigOffer(_), Step::MultisigOffer)
                | (Payload::Ack, Step::MultisigAck)
                | (Payload::Commit(_), Step::CommitUtxo)
                | (Payload::Psbt(_), Step::TradePsbt)
                | (Payload::Psbt(_), Step::SignedPsbt)
                | (Payload::Final(_), Step::Final)
        )
    }

    /// Syntactic bounds. Semantic checks live in `checks.rs`.
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Payload::MultisigOffer(c) => {
                if c.address.is_empty()
                    || c.address.len() > 100
                    || !c.address.bytes().all(|b| b.is_ascii_alphanumeric())
                {
                    return Err("channel address malformed");
                }
                if !is_hex(&c.redeem_script, MAX_SCRIPT_CHARS) {
                    return Err("redeem script not hex");
                }
                if let Some(s) = &c.script_pub_key {
                    if !is_hex(s, MAX_SCRIPT_CHARS) {
                        return Err("scriptPubKey not hex");
                    }
                }
                Ok(())
            }
            Payload::Ack => Ok(()),
            Payload::Commit(u) => {
                if u.txid.len() != 64 || !u.txid.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("commit txid malformed");
                }
                if !is_hex(&u.script_pub_key, MAX_SCRIPT_CHARS)
                    || !is_hex(&u.redeem_script, MAX_SCRIPT_CHARS)
                {
                    return Err("commit script not hex");
                }
                Ok(())
            }
            Payload::Psbt(p) => {
                if is_hex(p, MAX_PSBT_CHARS) {
                    Ok(())
                } else {
                    Err("psbt not hex or too large")
                }
            }
            Payload::Final(t) => {
                if t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()) {
                    Ok(())
                } else {
                    Err("final txid malformed")
                }
            }
            Payload::Terminate(r) => {
                if r.len() <= MAX_REASON_BYTES {
                    Ok(())
                } else {
                    Err("terminate reason too long")
                }
            }
        }
    }

    fn canonical(&self) -> Vec<u8> {
        let mut b = Vec::new();
        let mut put = |x: &[u8]| {
            b.extend_from_slice(&(x.len() as u32).to_be_bytes());
            b.extend_from_slice(x);
        };
        match self {
            Payload::MultisigOffer(c) => {
                put(c.address.as_bytes());
                put(c.redeem_script.to_ascii_lowercase().as_bytes());
                put(c
                    .script_pub_key
                    .as_deref()
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .as_bytes());
            }
            Payload::Ack => {}
            Payload::Commit(u) => {
                put(u.txid.to_ascii_lowercase().as_bytes());
                put(&u.vout.to_be_bytes());
                put(&u.amount.sat().to_be_bytes());
                put(u.script_pub_key.to_ascii_lowercase().as_bytes());
                put(u.redeem_script.to_ascii_lowercase().as_bytes());
            }
            Payload::Psbt(p) => put(p.to_ascii_lowercase().as_bytes()),
            Payload::Final(t) => put(t.to_ascii_lowercase().as_bytes()),
            Payload::Terminate(r) => put(r.as_bytes()),
        }
        b
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Step(Step),
    Terminate,
}

pub type Digest = [u8; 32];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    pub trade_id: TradeId,
    pub from: SessionId,
    pub kind: Kind,
    /// Transcript head after the previous accepted step (ignored for `Terminate`).
    pub prev: Digest,
    pub payload: Payload,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    Active,
    Settled,
    Terminated { by_peer: bool, reason: String },
    TimedOut,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwapError {
    /// Swap already settled, terminated or timed out.
    Finished,
    WrongTrade,
    WrongPeer,
    OutOfOrder {
        expected: Step,
        got: Step,
    },
    WrongSender,
    BadPrev,
    BadPayload(&'static str),
    /// `send` called for a step that is not ours or not next.
    NotOurTurn,
    TimedOut,
}

impl std::fmt::Display for SwapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for SwapError {}

fn advance_head(head: &Digest, step: Step, payload: &Payload) -> Digest {
    let mut b = Vec::new();
    b.extend_from_slice(b"tl-wallet-swap-v1/step");
    b.extend_from_slice(head);
    b.push(step.number());
    b.extend_from_slice(&payload.canonical());
    sha256::Hash::hash(&b).to_byte_array()
}

fn genesis(trade: &TradeId) -> Digest {
    let mut b = Vec::new();
    b.extend_from_slice(b"tl-wallet-swap-v1/genesis");
    b.extend_from_slice(trade.as_bytes());
    sha256::Hash::hash(&b).to_byte_array()
}

#[derive(Clone, Debug)]
pub struct Swap {
    role: Role,
    trade: TradeId,
    me: SessionId,
    peer: SessionId,
    head: Digest,
    /// Number of steps completed (0..=6).
    done: u8,
    status: Status,
    deadline_ms: u64,
}

impl Swap {
    pub fn new(
        role: Role,
        trade: TradeId,
        me: SessionId,
        peer: SessionId,
        now_ms: u64,
        timeout_ms: u64,
    ) -> Swap {
        Swap {
            role,
            trade,
            me,
            peer,
            head: genesis(&trade),
            done: 0,
            status: Status::Active,
            deadline_ms: now_ms.saturating_add(timeout_ms),
        }
    }

    pub fn role(&self) -> Role {
        self.role
    }

    pub fn trade_id(&self) -> TradeId {
        self.trade
    }

    pub fn status(&self) -> &Status {
        &self.status
    }

    pub fn is_active(&self) -> bool {
        self.status == Status::Active
    }

    pub fn steps_done(&self) -> u8 {
        self.done
    }

    pub fn head(&self) -> Digest {
        self.head
    }

    /// The step that must occur next, if the swap is still active.
    pub fn next_step(&self) -> Option<Step> {
        if self.status == Status::Active {
            Step::from_number(self.done + 1)
        } else {
            None
        }
    }

    /// Move to `TimedOut` if the deadline passed. Returns whether the swap is still active.
    pub fn tick(&mut self, now_ms: u64) -> bool {
        if self.status == Status::Active && now_ms >= self.deadline_ms {
            self.status = Status::TimedOut;
        }
        self.status == Status::Active
    }

    fn finish_if_complete(&mut self) {
        if self.done == 6 {
            self.status = Status::Settled;
        }
    }

    /// Accept one envelope from the peer.
    pub fn receive(&mut self, env: &Envelope, now_ms: u64) -> Result<Kind, SwapError> {
        if self.status != Status::Active {
            return Err(SwapError::Finished);
        }
        if !self.tick(now_ms) {
            return Err(SwapError::TimedOut);
        }
        if env.trade_id != self.trade {
            return Err(SwapError::WrongTrade);
        }
        if env.from != self.peer {
            return Err(SwapError::WrongPeer);
        }
        env.payload.validate().map_err(SwapError::BadPayload)?;
        match env.kind {
            Kind::Terminate => {
                let Payload::Terminate(reason) = &env.payload else {
                    return Err(SwapError::BadPayload("terminate without reason"));
                };
                self.status = Status::Terminated {
                    by_peer: true,
                    reason: reason.clone(),
                };
                Ok(Kind::Terminate)
            }
            Kind::Step(step) => {
                let expected = Step::from_number(self.done + 1).ok_or(SwapError::Finished)?;
                if step != expected {
                    return Err(SwapError::OutOfOrder {
                        expected,
                        got: step,
                    });
                }
                if step.sender() != self.role.other() {
                    return Err(SwapError::WrongSender);
                }
                if env.prev != self.head {
                    return Err(SwapError::BadPrev);
                }
                if !env.payload.shape_matches(step) {
                    return Err(SwapError::BadPayload("payload does not match step"));
                }
                self.head = advance_head(&self.head, step, &env.payload);
                self.done += 1;
                self.finish_if_complete();
                Ok(Kind::Step(step))
            }
        }
    }

    /// Produce our next outgoing step.
    pub fn send(
        &mut self,
        step: Step,
        payload: Payload,
        now_ms: u64,
    ) -> Result<Envelope, SwapError> {
        if self.status != Status::Active {
            return Err(SwapError::Finished);
        }
        if !self.tick(now_ms) {
            return Err(SwapError::TimedOut);
        }
        let expected = Step::from_number(self.done + 1).ok_or(SwapError::Finished)?;
        if step != expected || step.sender() != self.role {
            return Err(SwapError::NotOurTurn);
        }
        payload.validate().map_err(SwapError::BadPayload)?;
        if !payload.shape_matches(step) {
            return Err(SwapError::BadPayload("payload does not match step"));
        }
        let prev = self.head;
        self.head = advance_head(&self.head, step, &payload);
        self.done += 1;
        self.finish_if_complete();
        Ok(Envelope {
            trade_id: self.trade,
            from: self.me.clone(),
            kind: Kind::Step(step),
            prev,
            payload,
        })
    }

    /// Local abort (legacy `terminateTrade`): ends the swap and yields the message for the peer.
    pub fn terminate(&mut self, reason: &str) -> Result<Envelope, SwapError> {
        if self.status != Status::Active {
            return Err(SwapError::Finished);
        }
        let mut r = reason.to_string();
        while r.len() > MAX_REASON_BYTES {
            r.pop();
        }
        self.status = Status::Terminated {
            by_peer: false,
            reason: r.clone(),
        };
        Ok(Envelope {
            trade_id: self.trade,
            from: self.me.clone(),
            kind: Kind::Terminate,
            prev: self.head,
            payload: Payload::Terminate(r),
        })
    }
}
