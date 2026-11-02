//! Typed errors. Nothing in this crate panics on untrusted input.

use tl_wallet_core::vault::VaultError;
use tl_wallet_core::{Error as WalletError, Network};

/// A failure reported by the node adapter. Carries text from the node, so `Display` truncates it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeError {
    /// The node could not be reached or the transport failed.
    Transport(String),
    /// The node answered with a JSON-RPC error.
    Rpc { code: i64, message: String },
    /// The node answered with something the adapter could not interpret.
    Malformed(String),
}

fn clip(s: &str) -> String {
    s.chars().take(200).collect()
}

impl core::fmt::Display for NodeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            NodeError::Transport(m) => write!(f, "node transport: {}", clip(m)),
            NodeError::Rpc { code, message } => write!(f, "node rpc {code}: {}", clip(message)),
            NodeError::Malformed(m) => write!(f, "node response malformed: {}", clip(m)),
        }
    }
}

impl std::error::Error for NodeError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    /// The configured network has no desktop support (Dogecoin: the scan carries no prev-tx data).
    UnsupportedNetwork(Network),
    /// The node reports another chain than the configured network requires.
    WrongChain {
        expected: &'static [&'static str],
        actual: String,
    },
    /// The wallet is locked.
    Locked,
    /// No vault exists yet.
    NoVault,
    /// A vault already exists; `create` and `import` never overwrite it.
    VaultExists,
    /// The password did not open the vault (a tampered vault gives the same answer).
    WrongPassword,
    /// Any other vault failure.
    Vault(VaultError),
    /// Mnemonic, address, coin selection, PSBT or capability failure from `tl-wallet-core`.
    Wallet(WalletError),
    Node(NodeError),
    /// The scan returned a UTXO whose script is not one of this account's.
    ForeignUtxo {
        txid: String,
        vout: u32,
    },
    /// The scan result is malformed.
    InvalidScan(&'static str),
    /// Fee rate is zero or above the configured maximum.
    InvalidFeeRate {
        rate: u64,
        max: u64,
    },
    /// No fee rate was given, the node has no estimate and the network is not regtest.
    NoFeeEstimate,
    /// The fee exceeds the configured absolute maximum.
    FeeAboveMax {
        fee: u64,
        max: u64,
    },
    /// The pending-plan table is full.
    TooManyPending,
    /// No pending plan has this id (never existed, consumed, cancelled, or cleared by lock).
    UnknownPlan,
    /// The plan expired before it was confirmed. It is consumed.
    PlanExpired,
    /// Signing did not produce a final transaction.
    SigningIncomplete,
    /// The node accepted a transaction whose txid differs from the one signed locally. The
    /// transaction was broadcast.
    BroadcastTxidMismatch {
        local: String,
        node: String,
    },
    /// The injected entropy source failed.
    Entropy,
    /// An internal invariant did not hold.
    Internal(&'static str),
}

impl core::fmt::Display for CoreError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for CoreError {}

impl From<NodeError> for CoreError {
    fn from(e: NodeError) -> Self {
        CoreError::Node(e)
    }
}

impl From<WalletError> for CoreError {
    fn from(e: WalletError) -> Self {
        match e {
            WalletError::FeeAboveBound { fee, bound } => CoreError::FeeAboveMax { fee, max: bound },
            other => CoreError::Wallet(other),
        }
    }
}

impl From<VaultError> for CoreError {
    fn from(e: VaultError) -> Self {
        match e {
            VaultError::WrongPasswordOrTampered => CoreError::WrongPassword,
            VaultError::NoVault => CoreError::NoVault,
            VaultError::AlreadyExists => CoreError::VaultExists,
            other => CoreError::Vault(other),
        }
    }
}
