//! Wallet configuration. The network is explicit and never inferred.

use tl_wallet_core::vault::Kdf;
use tl_wallet_core::Network;

/// Pending send plans held at once.
pub const MAX_PENDING_PLANS: usize = 8;

/// Fee-estimation target (blocks) passed to the node.
pub const FEE_CONF_TARGET: u16 = 6;

/// Virtual size of a transaction without inputs: 10.5 vB overhead + one P2WSH recipient (43 vB)
/// + one P2WPKH change output (31 vB), rounded up. Conservative for the common P2WPKH recipient.
pub const TX_FIXED_VBYTES: u64 = 85;

/// Virtual size of one P2WPKH input.
pub const INPUT_VBYTES: u64 = 68;

/// Largest single amount accepted from a scan (84 million coins, the Litecoin supply cap).
pub const MAX_MONEY_SATS: u64 = 84_000_000 * 100_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub network: Network,
    /// KDF for newly created vaults. Existing vaults carry their own parameters in the header.
    pub kdf: Kdf,
    /// Fee rate used on regtest when the caller gives none and the node has no estimate.
    pub default_fee_rate_sat_vb: u64,
    /// Largest accepted fee rate, whether given by the caller or estimated by the node.
    pub max_fee_rate_sat_vb: u64,
    /// Largest accepted absolute fee of one transaction.
    pub max_fee_sats: u64,
    /// Lifetime of a prepared plan.
    pub plan_ttl_ms: u64,
    /// Lifetime of the signing capability granted inside `confirm_send`.
    pub capability_ttl_ms: u64,
}

impl Config {
    pub fn new(network: Network) -> Self {
        Config {
            network,
            kdf: Kdf::DEFAULT,
            default_fee_rate_sat_vb: 2,
            max_fee_rate_sat_vb: 1_000,
            max_fee_sats: 1_000_000,
            plan_ttl_ms: 120_000,
            capability_ttl_ms: 30_000,
        }
    }
}

/// Node chain names the network may run on. `None` for networks the desktop wallet does not
/// support.
pub fn expected_chains(network: Network) -> Option<&'static [&'static str]> {
    match network {
        Network::BtcRegtest | Network::LtcRegtest => Some(&["regtest"]),
        Network::BtcTest => Some(&["test", "testnet4"]),
        Network::LtcTest => Some(&["test"]),
        Network::Btc | Network::Ltc => Some(&["main"]),
        Network::Doge | Network::DogeTest => None,
    }
}

pub(crate) fn is_regtest(network: Network) -> bool {
    matches!(network, Network::BtcRegtest | Network::LtcRegtest)
}
