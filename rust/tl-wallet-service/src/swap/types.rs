//! Trade description shared by the order book and the swap state machine
//! (`packages/wallet-fe/src/app/utils/swapper/common.ts`: `ITradeInfo`, `IBuyerSellerInfo`,
//! `ISpotTradeProps`, `IFuturesTradeProps`).

use crate::amount::Amount;
use bitcoin::hashes::{sha256, Hash};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Role {
    Buyer,
    Seller,
}

impl Role {
    pub fn other(self) -> Role {
        match self {
            Role::Buyer => Role::Seller,
            Role::Seller => Role::Buyer,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SessionId(String);

impl SessionId {
    /// Orderbook socket ids: 1..=128 printable ASCII characters without spaces.
    pub fn parse(s: &str) -> Option<SessionId> {
        if s.is_empty() || s.len() > 128 || !s.bytes().all(|b| b.is_ascii_graphic()) {
            return None;
        }
        Some(SessionId(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TradeId([u8; 32]);

impl TradeId {
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        self.0.iter().map(|b| format!("{b:02x}")).collect()
    }
}

impl std::fmt::Debug for TradeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "TradeId({})", self.to_hex())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct KeyPair {
    pub address: String,
    /// Compressed public key, lowercase hex.
    pub pubkey: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Party {
    pub keypair: KeyPair,
    pub session: SessionId,
}

/// Property id `-1` is the base coin (LTC) in the legacy swapper (`propIdForSale === -1`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpotProps {
    pub amount_desired: Amount,
    pub amount_for_sale: Amount,
    pub prop_id_desired: i64,
    pub prop_id_for_sale: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FuturesProps {
    pub amount: Amount,
    pub contract_id: u32,
    /// Coin per contract.
    pub price: Amount,
    pub leverage: u32,
    pub collateral: Amount,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TradeKind {
    Spot(SpotProps),
    Futures(FuturesProps),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeInfo {
    pub buyer: Party,
    pub seller: Party,
    pub taker: SessionId,
    pub maker: SessionId,
    pub kind: TradeKind,
}

fn put(buf: &mut Vec<u8>, bytes: &[u8]) {
    buf.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    buf.extend_from_slice(bytes);
}

impl TradeInfo {
    pub fn party(&self, role: Role) -> &Party {
        match role {
            Role::Buyer => &self.buyer,
            Role::Seller => &self.seller,
        }
    }

    /// The legacy protocol had no trade identifier; messages were tied only to socket ids. Both
    /// sides derive the same id from the full trade terms, so any disagreement about parties,
    /// keys or amounts yields different ids and the peer's messages are rejected as foreign.
    pub fn id(&self) -> TradeId {
        let mut b: Vec<u8> = Vec::new();
        put(&mut b, b"tl-wallet-swap-v1/trade-id");
        for p in [&self.buyer, &self.seller] {
            put(&mut b, p.session.as_str().as_bytes());
            put(&mut b, p.keypair.address.as_bytes());
            put(&mut b, p.keypair.pubkey.as_bytes());
        }
        put(&mut b, self.taker.as_str().as_bytes());
        put(&mut b, self.maker.as_str().as_bytes());
        match &self.kind {
            TradeKind::Spot(s) => {
                put(&mut b, b"spot");
                put(&mut b, &s.amount_desired.sat().to_be_bytes());
                put(&mut b, &s.amount_for_sale.sat().to_be_bytes());
                put(&mut b, &s.prop_id_desired.to_be_bytes());
                put(&mut b, &s.prop_id_for_sale.to_be_bytes());
            }
            TradeKind::Futures(f) => {
                put(&mut b, b"futures");
                put(&mut b, &f.amount.sat().to_be_bytes());
                put(&mut b, &f.contract_id.to_be_bytes());
                put(&mut b, &f.price.sat().to_be_bytes());
                put(&mut b, &f.leverage.to_be_bytes());
                put(&mut b, &f.collateral.sat().to_be_bytes());
            }
        }
        TradeId(sha256::Hash::hash(&b).to_byte_array())
    }

    /// Base-asset quantity the trade moves (what the order's `amount` is measured in).
    pub fn base_amount(&self) -> Amount {
        match &self.kind {
            TradeKind::Spot(s) => s.amount_desired,
            TradeKind::Futures(f) => f.amount,
        }
    }
}
