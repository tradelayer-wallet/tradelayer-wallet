//! Boundaries to the outside world. The desktop shell implements [`NodeRpc`] (over
//! `tl-rpc-client`), [`Clock`] (system time) and [`Entropy`] (OS randomness); tests use scripted
//! implementations.

use crate::error::{CoreError, NodeError};

/// One unspent output as the node's `scantxoutset` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedUtxo {
    /// Transaction id, 64 hex characters.
    pub txid: String,
    pub vout: u32,
    /// `scriptPubKey` as hex.
    pub script_pubkey_hex: String,
    pub amount_sats: u64,
    /// Height of the block that confirmed the output.
    pub height: u64,
    /// The output belongs to a coinbase transaction (`scantxoutset` `coinbase` field).
    pub coinbase: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanResult {
    /// Chain tip height at scan time.
    pub height: u64,
    pub utxos: Vec<ScannedUtxo>,
}

/// Node access. The adapter must not add behaviour: no retries that re-broadcast, no method
/// beyond these four.
pub trait NodeRpc {
    /// `getblockchaininfo.chain`: `"main"`, `"test"`, `"testnet4"`, `"regtest"`, ...
    fn chain(&mut self) -> Result<String, NodeError>;
    /// `scantxoutset start` over output descriptors (`addr(...)`; no checksum is required).
    fn scan(&mut self, descriptors: &[String]) -> Result<ScanResult, NodeError>;
    /// `estimatesmartfee`, converted to sat/vB. `None` when the node has no estimate.
    fn fee_rate_sat_per_vb(&mut self, conf_target: u16) -> Result<Option<u64>, NodeError>;
    /// `sendrawtransaction`; returns the txid.
    fn broadcast(&mut self, raw_tx_hex: &str) -> Result<String, NodeError>;
}

/// Wall-clock milliseconds. Only differences and comparisons matter.
pub trait Clock {
    fn now_ms(&self) -> u64;
}

/// Cryptographic randomness. Used for the mnemonic, plan ids, and (through the vault) KDF salts
/// and AEAD nonces.
pub trait Entropy {
    fn fill(&mut self, buf: &mut [u8]) -> Result<(), CoreError>;
}
