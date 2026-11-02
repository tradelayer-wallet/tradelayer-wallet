//! `tl-desktop-core`: the testable core of the TradeLayer desktop wallet.
//!
//! Replaces the Electron/Node wallet's local server, RPC proxy and signing path with a small
//! library the Tauri shell calls directly. The node, the clock and the entropy source are
//! traits ([`NodeRpc`], [`Clock`], [`Entropy`]); the vault comes from `tl-wallet-core`.
//!
//! The rules, in one place: the network is explicit and the node's chain must match it before
//! any scan or broadcast; a send is prepared (previewed) first and only the confirm call signs;
//! a plan is single-use, expires after two minutes and dies with the session lock.
#![forbid(unsafe_code)]

pub mod config;
pub mod error;
pub mod session;
pub mod store;
pub mod traits;
pub mod wallet;

pub use config::{expected_chains, Config, MAX_PENDING_PLANS};
pub use error::{CoreError, NodeError};
pub use store::{FileStore, InMemoryStore};
pub use traits::{Clock, Entropy, NodeRpc, ScanResult, ScannedUtxo};
pub use wallet::{Balance, SendPreview, SendResult, Status, Wallet, DESKTOP_ORIGIN};
