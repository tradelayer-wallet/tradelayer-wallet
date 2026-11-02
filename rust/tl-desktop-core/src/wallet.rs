//! The desktop wallet core: vault session, chain-checked scan, confirm-gated send.

use crate::config::{
    expected_chains, is_regtest, Config, FEE_CONF_TARGET, INPUT_VBYTES, MAX_MONEY_SATS,
    TX_FIXED_VBYTES,
};
use crate::error::CoreError;
use crate::session::{InsertError, PlanTable, TakeError};
use crate::traits::{Clock, Entropy, NodeRpc, ScanResult};
use bitcoin::hex::FromHex;
use bitcoin::{OutPoint, ScriptBuf, Txid};
use std::collections::BTreeSet;
use std::str::FromStr;
use tl_wallet_core::capability::{sign_psbt, InputRef, OutputRef, Requester, SigningCapability};
use tl_wallet_core::coin::{FeePolicy, Utxo, MAX_UTXOS};
use tl_wallet_core::keys::{generate_mnemonic, Account, ChangeMode, ImportedMnemonic};
use tl_wallet_core::tx::{build_payment, PaymentRequest, SignOptions, SignOutcome};
use tl_wallet_core::vault::manager::VAULT_KEY;
use tl_wallet_core::vault::{Random, VaultError, VaultManager, VaultStore};
use tl_wallet_core::{Address, Network, Origin, Sats};
use zeroize::Zeroizing;

/// The origin every desktop signing capability is granted to: the webview origin Tauri 2 serves
/// the UI from on Windows. `Origin::from_url` of `tl-wallet-core` accepts only http(s), so the
/// app scheme (`tauri://localhost`) is not available. Granting a capability is the user-approval act; only the confirm
/// button of the trusted UI may reach [`Wallet::confirm_send`].
pub const DESKTOP_ORIGIN: &str = "http://tauri.localhost";

/// Bound on remembered spent outpoints (see [`Wallet::confirm_send`]).
const MAX_SPENT_MEMORY: usize = 4_096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    /// Canonical network id, e.g. `"BTCREGTEST"`.
    pub network_id: String,
    pub has_vault: bool,
    pub unlocked: bool,
    /// The chain the node reported, `None` if the node did not answer.
    pub node_chain: Option<String>,
    /// True only when the node answered and its chain is the one the network requires.
    pub chain_matches: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Balance {
    pub confirmed_sats: u64,
    /// `scantxoutset` does not see the mempool, so this is always 0.
    pub unconfirmed_sats: u64,
    /// Coinbase outputs with fewer than [`COINBASE_MATURITY`] confirmations: owned, not yet
    /// spendable, not in `confirmed_sats` and never selected.
    pub immature_sats: u64,
    pub utxo_count: usize,
    /// Chain tip height at scan time.
    pub height: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendPreview {
    /// 128 random bits as 32 lowercase hex characters.
    pub plan_id: String,
    pub to: String,
    pub amount_sats: u64,
    pub fee_sats: u64,
    pub change_sats: u64,
    pub input_count: usize,
    pub fee_rate_sat_vb: u64,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendResult {
    pub txid: String,
}

struct PendingPlan {
    plan: tl_wallet_core::tx::PaymentPlan,
}

/// Hands the injected [`Entropy`] to the vault as its [`Random`].
struct EntropyRandom<'a, E: Entropy>(&'a mut E);

impl<E: Entropy> Random for EntropyRandom<'_, E> {
    fn fill(&mut self, buf: &mut [u8]) -> Result<(), VaultError> {
        self.0.fill(buf).map_err(|_| VaultError::Random)
    }
}

pub struct Wallet<N: NodeRpc, S: VaultStore, C: Clock, E: Entropy> {
    cfg: Config,
    node: N,
    /// Taken while a `VaultManager` borrows it; always `Some` between calls.
    store: Option<S>,
    clock: C,
    entropy: E,
    account: Option<Account>,
    plans: PlanTable<PendingPlan>,
    /// Outpoints of transactions this wallet broadcast and the node's UTXO set may still list
    /// (the scan does not see the mempool). Excluded from coin selection until they vanish from
    /// a scan.
    spent: Vec<OutPoint>,
}

impl<N: NodeRpc, S: VaultStore, C: Clock, E: Entropy> Wallet<N, S, C, E> {
    pub fn new(cfg: Config, node: N, store: S, clock: C, entropy: E) -> Self {
        Wallet {
            cfg,
            node,
            store: Some(store),
            clock,
            entropy,
            account: None,
            plans: PlanTable::new(),
            spent: Vec::new(),
        }
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    /// Number of live plus not-yet-purged pending plans.
    pub fn pending_plans(&self) -> usize {
        self.plans.len()
    }

    pub fn status(&mut self) -> Status {
        let network = self.cfg.network;
        let has_vault = self
            .with_vault(|m| matches!(m.store().get(VAULT_KEY), Ok(Some(_))))
            .unwrap_or(false);
        let (node_chain, chain_matches) = match self.node.chain() {
            Ok(chain) => {
                let ok = expected_chains(network).is_some_and(|e| e.contains(&chain.as_str()));
                (Some(chain.chars().take(64).collect()), ok)
            }
            Err(_) => (None, false),
        };
        Status {
            network_id: network.id().to_string(),
            has_vault,
            unlocked: self.account.is_some(),
            node_chain,
            chain_matches,
        }
    }

    /// Create a vault around a fresh 12-word mnemonic and unlock it. The phrase is returned
    /// once, for the backup screen; the caller must not log or persist it.
    pub fn create(&mut self, password: &str) -> Result<String, CoreError> {
        self.check_supported()?;
        let mut raw = Zeroizing::new([0u8; 16]);
        self.entropy.fill(&mut raw[..])?;
        let phrase = Zeroizing::new(generate_mnemonic(&raw)?);
        let mnemonic = ImportedMnemonic::parse_phrase(&phrase)?;
        self.install(&mnemonic, password)?;
        Ok(phrase.to_string())
    }

    /// Create a vault from an existing 12-word phrase and unlock it.
    pub fn import(&mut self, phrase: &str, password: &str) -> Result<(), CoreError> {
        self.check_supported()?;
        let mnemonic = ImportedMnemonic::parse_phrase(phrase)?;
        self.install(&mnemonic, password)
    }

    fn install(&mut self, mnemonic: &ImportedMnemonic, password: &str) -> Result<(), CoreError> {
        let account = self.derive(mnemonic)?;
        self.with_vault(|m| m.create(mnemonic, password))?
            .map_err(CoreError::from)?;
        self.plans.clear();
        self.account = Some(account);
        Ok(())
    }

    fn derive(&self, mnemonic: &ImportedMnemonic) -> Result<Account, CoreError> {
        Account::from_mnemonic(mnemonic, self.cfg.network, ChangeMode::InternalChain)
            .map_err(CoreError::from)
    }

    pub fn unlock(&mut self, password: &str) -> Result<(), CoreError> {
        self.check_supported()?;
        let secret = self
            .with_vault(|m| m.unlock(password))?
            .map_err(CoreError::from)?;
        if self.account.is_some() {
            // Already unlocked: the password was verified, nothing else changes.
            return Ok(());
        }
        let phrase = secret
            .as_str()
            .ok_or(CoreError::Vault(VaultError::InvalidSecret))?;
        let mnemonic = ImportedMnemonic::parse_phrase(phrase)
            .map_err(|_| CoreError::Vault(VaultError::InvalidSecret))?;
        self.account = Some(self.derive(&mnemonic)?);
        Ok(())
    }

    /// Drop the account (its keys are erased on drop) and every pending plan.
    pub fn lock(&mut self) {
        self.account = None;
        self.plans.clear();
    }

    pub fn receive_address(&self) -> Result<String, CoreError> {
        let account = self.account.as_ref().ok_or(CoreError::Locked)?;
        account.receive_address().encode().map_err(CoreError::from)
    }

    pub fn balance(&mut self) -> Result<Balance, CoreError> {
        if self.account.is_none() {
            return Err(CoreError::Locked);
        }
        self.ensure_chain()?;
        let account = self.account.as_ref().ok_or(CoreError::Locked)?;
        let scan = scan_account(&mut self.node, account)?;
        let (utxos, immature) = utxos_from_scan(account, &scan)?;
        let total = Sats::sum(utxos.iter().map(|u| u.value))?;
        Ok(Balance {
            confirmed_sats: total.0,
            unconfirmed_sats: 0,
            immature_sats: immature.0,
            utxo_count: utxos.len(),
            height: scan.height,
        })
    }

    /// Build and remember a send; nothing is signed or broadcast. The preview is what the UI
    /// shows next to the confirm button.
    pub fn prepare_send(
        &mut self,
        to: &str,
        amount_sats: u64,
        fee_rate: Option<u64>,
    ) -> Result<SendPreview, CoreError> {
        if self.account.is_none() {
            return Err(CoreError::Locked);
        }
        self.ensure_chain()?;
        let network = self.cfg.network;
        let dest = Address::parse(network, to)?;
        let now = self.clock.now_ms();
        self.plans.purge_expired(now);
        if self.plans.len() >= crate::config::MAX_PENDING_PLANS {
            return Err(CoreError::TooManyPending);
        }
        let rate = self.resolve_fee_rate(fee_rate)?;

        let account = self.account.as_ref().ok_or(CoreError::Locked)?;
        let scan = scan_account(&mut self.node, account)?;
        let (all, _immature) = utxos_from_scan(account, &scan)?;
        // Forget spends the node has caught up with, then hide what is still in flight.
        let live: BTreeSet<OutPoint> = all.iter().map(Utxo::outpoint).collect();
        self.spent.retain(|o| live.contains(o));
        let reserved: BTreeSet<OutPoint> = self
            .plans
            .values()
            .flat_map(|p| p.plan.inputs.iter().map(|i| i.outpoint))
            .chain(self.spent.iter().copied())
            .collect();
        let candidates: Vec<Utxo> = all
            .into_iter()
            .filter(|u| !reserved.contains(&u.outpoint()))
            .collect();

        let policy = FeePolicy::PerVbyte {
            sats_per_vb: rate,
            fixed_vbytes: TX_FIXED_VBYTES,
            input_vbytes: INPUT_VBYTES,
        };
        let plan = build_payment(
            account,
            &PaymentRequest {
                to: &dest,
                amount: Sats(amount_sats),
                utxos: &candidates,
                fee: policy,
                max_fee: Sats(self.cfg.max_fee_sats),
                payload: None,
            },
        )?;

        let expires_at_ms = now
            .checked_add(self.cfg.plan_ttl_ms)
            .ok_or(CoreError::Internal("clock overflow"))?;
        let plan_id = self.fresh_plan_id()?;
        let preview = SendPreview {
            plan_id: plan_id.clone(),
            to: to.to_string(),
            amount_sats,
            fee_sats: plan.fee.0,
            change_sats: plan.selection.change.0,
            input_count: plan.inputs.len(),
            fee_rate_sat_vb: rate,
            expires_at_ms,
        };
        match self
            .plans
            .insert(plan_id, expires_at_ms, PendingPlan { plan }, now)
        {
            Ok(()) => Ok(preview),
            Err(InsertError::Full) => Err(CoreError::TooManyPending),
            Err(InsertError::Duplicate) => Err(CoreError::Internal("plan id collision")),
        }
    }

    /// Sign and broadcast a prepared plan. Call this only from the trusted UI's confirm button:
    /// it is the user-approval act, and it grants the one-use signing capability internally.
    ///
    /// The plan is removed before anything else happens, so an id is usable once even if the
    /// chain check, signing or broadcast fails.
    pub fn confirm_send(&mut self, plan_id: &str) -> Result<SendResult, CoreError> {
        if self.account.is_none() {
            return Err(CoreError::Locked);
        }
        let now = self.clock.now_ms();
        let pending = self.plans.take(plan_id, now).map_err(|e| match e {
            TakeError::Unknown => CoreError::UnknownPlan,
            TakeError::Expired => CoreError::PlanExpired,
        })?;
        self.ensure_chain()?;
        let account = self.account.as_ref().ok_or(CoreError::Locked)?;
        let plan = pending.plan;

        let origin =
            Origin::from_url(DESKTOP_ORIGIN).map_err(|_| CoreError::Internal("desktop origin"))?;
        let cap_expiry = now
            .checked_add(self.cfg.capability_ttl_ms)
            .ok_or(CoreError::Internal("clock overflow"))?;
        let inputs: Vec<InputRef> = plan.inputs.clone();
        let outputs: Vec<OutputRef> = plan.outputs.clone();
        let cap = SigningCapability::for_transaction(
            origin.clone(),
            account.id(),
            cap_expiry,
            inputs,
            outputs,
            plan.fee,
        );
        let requester = Requester {
            origin,
            network: self.cfg.network,
        };
        let outcome = sign_psbt(
            cap,
            &requester,
            account,
            now,
            plan.psbt,
            &SignOptions {
                finalize: true,
                ..SignOptions::default()
            },
        )?;
        let (raw_tx_hex, local_txid) = match outcome {
            SignOutcome::Final { raw_tx_hex, txid } => (raw_tx_hex, txid),
            SignOutcome::Partial { .. } => return Err(CoreError::SigningIncomplete),
        };

        let node_txid = self.node.broadcast(&raw_tx_hex)?;
        for i in &plan.inputs {
            if self.spent.len() >= MAX_SPENT_MEMORY {
                self.spent.remove(0);
            }
            self.spent.push(i.outpoint);
        }
        if !node_txid.eq_ignore_ascii_case(&local_txid) {
            return Err(CoreError::BroadcastTxidMismatch {
                local: local_txid,
                node: node_txid.chars().take(80).collect(),
            });
        }
        Ok(SendResult { txid: local_txid })
    }

    /// Drop a pending plan; true if one was removed.
    pub fn cancel_send(&mut self, plan_id: &str) -> bool {
        self.plans.remove(plan_id)
    }

    /// Drop expired plans. Called implicitly by `prepare_send`; the shell may call it on a timer.
    pub fn tick(&mut self) {
        let now = self.clock.now_ms();
        self.plans.purge_expired(now);
    }

    // ------------------------------------------------------------------ internals

    fn check_supported(&self) -> Result<(), CoreError> {
        match expected_chains(self.cfg.network) {
            Some(_) => Ok(()),
            None => Err(CoreError::UnsupportedNetwork(self.cfg.network)),
        }
    }

    /// The node must be on the chain the configured network requires. Called before every scan,
    /// signing and broadcast; never skipped, never cached.
    fn ensure_chain(&mut self) -> Result<(), CoreError> {
        let expected = expected_chains(self.cfg.network)
            .ok_or(CoreError::UnsupportedNetwork(self.cfg.network))?;
        let actual = self.node.chain()?;
        if expected.contains(&actual.as_str()) {
            Ok(())
        } else {
            Err(CoreError::WrongChain {
                expected,
                actual: actual.chars().take(64).collect(),
            })
        }
    }

    fn resolve_fee_rate(&mut self, requested: Option<u64>) -> Result<u64, CoreError> {
        let rate = match requested {
            Some(r) => r,
            None => match self.node.fee_rate_sat_per_vb(FEE_CONF_TARGET)? {
                Some(r) => r,
                None if is_regtest(self.cfg.network) => self.cfg.default_fee_rate_sat_vb,
                None => return Err(CoreError::NoFeeEstimate),
            },
        };
        let max = self.cfg.max_fee_rate_sat_vb;
        if rate == 0 || rate > max {
            return Err(CoreError::InvalidFeeRate { rate, max });
        }
        Ok(rate)
    }

    fn fresh_plan_id(&mut self) -> Result<String, CoreError> {
        let mut raw = [0u8; 16];
        self.entropy.fill(&mut raw)?;
        let mut id = String::with_capacity(32);
        for b in raw {
            id.push_str(&format!("{b:02x}"));
        }
        Ok(id)
    }

    /// Run `f` on a `VaultManager` built over the wallet's store and entropy.
    fn with_vault<T>(
        &mut self,
        f: impl FnOnce(&mut VaultManager<S, EntropyRandom<'_, E>>) -> T,
    ) -> Result<T, CoreError> {
        let (network, kdf) = (self.cfg.network, self.cfg.kdf);
        kdf.validate()?;
        let store = self
            .store
            .take()
            .ok_or(CoreError::Internal("store unavailable"))?;
        let mut manager = VaultManager::new(store, EntropyRandom(&mut self.entropy), network, kdf)
            .map_err(|_| CoreError::Internal("vault manager"))?;
        let out = f(&mut manager);
        self.store = Some(manager.into_store());
        Ok(out)
    }
}

/// `scantxoutset` over the account's receive and change addresses.
fn scan_account<N: NodeRpc>(node: &mut N, account: &Account) -> Result<ScanResult, CoreError> {
    let receive = account.receive_address().encode()?;
    let change = account.change_address().encode()?;
    let mut descriptors = vec![format!("addr({receive})")];
    if change != receive {
        descriptors.push(format!("addr({change})"));
    }
    Ok(node.scan(&descriptors)?)
}

/// Confirmations a coinbase output needs before it may be spent (consensus rule shared by
/// Bitcoin and Litecoin).
pub const COINBASE_MATURITY: u64 = 100;

/// Validate a scan result and convert it. Any foreign or malformed entry rejects the whole scan.
/// Returns the spendable outputs and the total of immature coinbase outputs, which are left out.
fn utxos_from_scan(account: &Account, scan: &ScanResult) -> Result<(Vec<Utxo>, Sats), CoreError> {
    if scan.utxos.len() > MAX_UTXOS {
        return Err(CoreError::InvalidScan("too many utxos"));
    }
    let mut seen: BTreeSet<OutPoint> = BTreeSet::new();
    let mut out = Vec::with_capacity(scan.utxos.len());
    let mut immature = Sats(0);
    for u in &scan.utxos {
        let txid = Txid::from_str(&u.txid).map_err(|_| CoreError::InvalidScan("txid"))?;
        let bytes = Vec::<u8>::from_hex(&u.script_pubkey_hex)
            .map_err(|_| CoreError::InvalidScan("script hex"))?;
        let script = ScriptBuf::from_bytes(bytes);
        if !account.owns_script(&script) {
            return Err(CoreError::ForeignUtxo {
                txid: u.txid.chars().take(64).collect(),
                vout: u.vout,
            });
        }
        if u.amount_sats == 0 || u.amount_sats > MAX_MONEY_SATS {
            return Err(CoreError::InvalidScan("amount out of range"));
        }
        let utxo = Utxo {
            txid,
            vout: u.vout,
            value: Sats(u.amount_sats),
            script_pubkey: script,
            prev_tx: None,
        };
        if !seen.insert(utxo.outpoint()) {
            return Err(CoreError::InvalidScan("duplicate outpoint"));
        }
        if u.height > scan.height {
            return Err(CoreError::InvalidScan("utxo above tip"));
        }
        // Confirmations = tip - height + 1. A coinbase output is spendable from 100 on.
        if u.coinbase && scan.height - u.height + 1 < COINBASE_MATURITY {
            immature = immature
                .checked_add(utxo.value)
                .map_err(|_| CoreError::InvalidScan("amount overflow"))?;
            continue;
        }
        out.push(utxo);
    }
    Ok((out, immature))
}

impl<N: NodeRpc, S: VaultStore, C: Clock, E: Entropy> Wallet<N, S, C, E> {
    /// The network this wallet was configured for.
    pub fn network(&self) -> Network {
        self.cfg.network
    }
}
