//! Key handles: FE-speed's login keeps working in the desktop build without a private key,
//! xprv or WIF ever reaching the page.
//!
//! FE-speed's wallet-fe logs in with a mnemonic and asks `/keys/get-address` for the key at each
//! derivation path; it keeps the answer's `wif` and later posts it to `/api/sign-psbt` and
//! `/api/sign-tx`. [`HandleKeys`] (the service's `KeyBackend`) derives the key in Rust, keeps it in
//! a bounded in-memory table, and answers `{address, pubkey, privkey: "", wif: "tlk1:<id>"}`
//! where `<id>` is 128 random bits. [`HandleSigner`] (the `SignBackend`) resolves the handle to
//! the key and signs ([`super::localsign`]); `tln1:<address>` and an empty `wif` go to the node
//! wallet ([`crate::nodewallet`]), and anything else, a real WIF included, is refused.
//!
//! The table holds at most [`MAX_KEYS`] keys, evicts the least recently used when full, drops a
//! key unused for [`IDLE_TTL`], and is emptied by `/api/logout`, `/keys/logout` and
//! `stop-wallet-node` (`KeyBackend::clear`). Keys are erased when dropped. The same key derived
//! twice (login again) keeps its handle, so repeated logins do not grow the table.
//!
//! The mnemonic itself still travels the way FE-speed handles it: `new-wallet` returns it for the
//! backup screen and the page supplies it to `get-address`.

use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::hashes::Hash;
use bitcoin::hex::DisplayHex;
use bitcoin::secp256k1::{self, All, Message, Secp256k1};
use bitcoin::{CompressedPublicKey, NetworkKind, PublicKey, ScriptBuf};
use serde_json::json;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::str::FromStr;
use std::time::{Duration, Instant};
use tl_wallet_core::keys::{generate_mnemonic, ImportedMnemonic};
use tl_wallet_core::Network;
use tl_wallet_service::service::{CallResult, KeyBackend, SignBackend};
use tl_wallet_service::txbuilder::Utxo;

use super::localsign;
use crate::nodewallet::NodeWalletSigner;

pub const KEY_HANDLE_PREFIX: &str = "tlk1:";
/// Upper bound on live keys: a key-file login derives at most 256 (the service's own bound).
pub const MAX_KEYS: usize = 1024;
/// A handle unused for this long stops working; signing again needs a new login.
pub const IDLE_TTL: Duration = Duration::from_secs(12 * 60 * 60);

type R<T> = Result<T, String>;

/// One derived key. The secret never leaves this type except into a signature.
pub struct LocalKey {
    secret: secp256k1::SecretKey,
    public: secp256k1::PublicKey,
    network: Network,
    address: String,
}

impl Drop for LocalKey {
    fn drop(&mut self) {
        self.secret.non_secure_erase();
    }
}

impl std::fmt::Debug for LocalKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "LocalKey({}, <redacted>)", self.address)
    }
}

impl LocalKey {
    /// FE-speed's `getKeyPair`: BIP39 seed (empty passphrase), BIP32 `derivePath`, address
    /// `p2sh(p2wpkh(pubkey))` with the network's script-hash version.
    pub fn derive(
        secp: &Secp256k1<All>,
        network: Network,
        seed: &[u8; 64],
        path: &str,
    ) -> R<LocalKey> {
        let kind = if network.params().is_test {
            NetworkKind::Test
        } else {
            NetworkKind::Main
        };
        let mut master = Xpriv::new_master(kind, seed).map_err(|e| format!("seed: {e}"))?;
        let path =
            DerivationPath::from_str(path).map_err(|_| "derivation path malformed".to_string())?;
        let mut child = master
            .derive_priv(secp, &path)
            .map_err(|e| format!("derivation: {e}"))?;
        let secret = child.private_key;
        master.private_key.non_secure_erase();
        child.private_key.non_secure_erase();
        let public = secret.public_key(secp);
        let compressed = CompressedPublicKey(public);
        let redeem = ScriptBuf::new_p2wpkh(&compressed.wpubkey_hash());
        let mut payload = vec![network.params().p2sh_prefix];
        payload.extend_from_slice(&redeem.script_hash().to_byte_array());
        Ok(LocalKey {
            secret,
            public,
            network,
            address: bitcoin::base58::encode_check(&payload),
        })
    }

    pub fn network(&self) -> Network {
        self.network
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    pub fn pubkey_hex(&self) -> String {
        self.public.serialize().as_slice().to_lower_hex_string()
    }

    pub(crate) fn compressed(&self) -> CompressedPublicKey {
        CompressedPublicKey(self.public)
    }

    pub(super) fn bitcoin_pubkey(&self) -> PublicKey {
        PublicKey::new(self.public)
    }

    /// Deterministic RFC 6979 ECDSA without low-R grinding, what `tiny-secp256k1` produces.
    pub(crate) fn sign_digest(
        &self,
        secp: &Secp256k1<All>,
        msg: &Message,
    ) -> secp256k1::ecdsa::Signature {
        secp.sign_ecdsa(msg, &self.secret)
    }

    #[cfg(test)]
    pub fn secret_hex(&self) -> String {
        self.secret.secret_bytes().as_slice().to_lower_hex_string()
    }

    #[cfg(test)]
    pub fn wif(&self) -> String {
        let mut payload = vec![self.network.params().wif_prefix];
        payload.extend_from_slice(&self.secret.secret_bytes());
        payload.push(1);
        bitcoin::base58::encode_check(&payload)
    }
}

struct Entry {
    key: Rc<LocalKey>,
    last_used: Duration,
    seq: u64,
}

/// The bounded handle table. Time comes from `now`, so tests drive expiry.
pub struct KeyTable {
    entries: HashMap<String, Entry>,
    cap: usize,
    ttl: Duration,
    now: Box<dyn Fn() -> Duration>,
    seq: u64,
}

pub type SharedKeys = Rc<RefCell<KeyTable>>;

impl KeyTable {
    pub fn new() -> KeyTable {
        let base = Instant::now();
        KeyTable::with_limits(MAX_KEYS, IDLE_TTL, Box::new(move || base.elapsed()))
    }

    pub fn with_limits(cap: usize, ttl: Duration, now: Box<dyn Fn() -> Duration>) -> KeyTable {
        KeyTable {
            entries: HashMap::new(),
            cap: cap.max(1),
            ttl,
            now,
            seq: 0,
        }
    }

    pub fn shared() -> SharedKeys {
        Rc::new(RefCell::new(KeyTable::new()))
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    fn purge(&mut self, now: Duration) {
        let ttl = self.ttl;
        self.entries
            .retain(|_, e| now.saturating_sub(e.last_used) < ttl);
    }

    /// Store `key` and return its handle. The same key (network and public key) keeps its handle.
    pub fn insert(&mut self, key: LocalKey) -> R<String> {
        let now = (self.now)();
        self.purge(now);
        self.seq += 1;
        let seq = self.seq;
        if let Some((id, e)) = self
            .entries
            .iter_mut()
            .find(|(_, e)| e.key.network() == key.network() && e.key.public == key.public)
        {
            e.last_used = now;
            e.seq = seq;
            return Ok(format!("{KEY_HANDLE_PREFIX}{id}"));
        }
        while self.entries.len() >= self.cap {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, e)| (e.last_used, e.seq))
                .map(|(id, _)| id.clone());
            match oldest {
                Some(id) => {
                    self.entries.remove(&id);
                }
                None => break,
            }
        }
        let mut raw = [0u8; 16];
        getrandom::fill(&mut raw).map_err(|e| format!("entropy unavailable: {e}"))?;
        let id = raw.as_slice().to_lower_hex_string();
        self.entries.insert(
            id.clone(),
            Entry {
                key: Rc::new(key),
                last_used: now,
                seq,
            },
        );
        Ok(format!("{KEY_HANDLE_PREFIX}{id}"))
    }

    /// The key whose address is `address` on `network`, for the orderbook login. Unlike
    /// [`KeyTable::resolve`] this does not refresh the idle clock: a login renewed every few minutes
    /// must not keep an unused key alive past [`IDLE_TTL`].
    pub fn by_address(&self, address: &str, network: Network) -> Option<Rc<LocalKey>> {
        let now = (self.now)();
        self.entries
            .values()
            .find(|e| {
                e.key.network() == network
                    && e.key.address() == address
                    && now.saturating_sub(e.last_used) < self.ttl
            })
            .map(|e| e.key.clone())
    }

    /// The key behind `handle`, which must be for `network`. Resolving refreshes the idle clock.
    pub fn resolve(&mut self, handle: &str, network: Network) -> R<Rc<LocalKey>> {
        let id = handle
            .strip_prefix(KEY_HANDLE_PREFIX)
            .filter(|id| {
                id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            })
            .ok_or("key handle malformed")?;
        let now = (self.now)();
        let ttl = self.ttl;
        let Some(e) = self.entries.get_mut(id) else {
            return Err("unknown key handle; log in again".into());
        };
        if now.saturating_sub(e.last_used) >= ttl {
            self.entries.remove(id);
            return Err("key handle expired; log in again".into());
        }
        if e.key.network() != network {
            return Err("key handle belongs to another network".into());
        }
        e.last_used = now;
        Ok(e.key.clone())
    }
}

impl Default for KeyTable {
    fn default() -> KeyTable {
        KeyTable::new()
    }
}

/// `KeyBackend`: derives in Rust and answers handles.
pub struct HandleKeys {
    table: SharedKeys,
    secp: Rc<Secp256k1<All>>,
    on_clear: Option<Box<dyn Fn()>>,
}

impl HandleKeys {
    pub fn new(table: SharedKeys, secp: Rc<Secp256k1<All>>) -> HandleKeys {
        HandleKeys {
            table,
            secp,
            on_clear: None,
        }
    }

    /// Call `hook` whenever the table is emptied (UI logout, lock, `stop-wallet-node`).
    pub fn with_clear_hook(mut self, hook: Box<dyn Fn()>) -> HandleKeys {
        self.on_clear = Some(hook);
        self
    }
}

/// The four networks FE-speed's `networks` table has, by their exact labels.
fn parse_network(label: &str) -> R<Network> {
    match label {
        "LTC" | "LTCTEST" | "BTC" | "BTCTEST" => {
            Network::parse(label).map_err(|_| "Network not found!".to_string())
        }
        _ => Err("Network not found!".into()),
    }
}

impl KeyBackend for HandleKeys {
    fn new_mnemonic(&mut self, network: &str) -> R<String> {
        parse_network(network)?;
        let mut entropy = [0u8; 16];
        getrandom::fill(&mut entropy).map_err(|e| format!("entropy unavailable: {e}"))?;
        let phrase = generate_mnemonic(&entropy);
        entropy.fill(0);
        phrase.map_err(|e| e.to_string())
    }

    fn key_pair(&mut self, network: &str, mnemonic: &str, path: &str) -> CallResult {
        let net = parse_network(network)?;
        let phrase = ImportedMnemonic::parse_phrase(mnemonic).map_err(|e| e.to_string())?;
        let mut seed = phrase.to_seed();
        let key = LocalKey::derive(&self.secp, net, &seed, path);
        seed.fill(0);
        let key = key?;
        let (address, pubkey) = (key.address().to_string(), key.pubkey_hex());
        let handle = self.table.borrow_mut().insert(key)?;
        Ok(json!({ "address": address, "pubkey": pubkey, "privkey": "", "wif": handle }))
    }

    fn clear(&mut self) {
        self.table.borrow_mut().clear();
        if let Some(hook) = &self.on_clear {
            hook();
        }
    }
}

/// `SignBackend`: `tlk1:` handles sign with the in-memory key, everything else is the node
/// wallet's call (empty `wif`, `tln1:<address>`) or a refusal (a real WIF).
pub struct HandleSigner {
    node: NodeWalletSigner,
    table: SharedKeys,
    secp: Rc<Secp256k1<All>>,
}

impl HandleSigner {
    pub fn new(
        node: NodeWalletSigner,
        table: SharedKeys,
        secp: Rc<Secp256k1<All>>,
    ) -> HandleSigner {
        HandleSigner { node, table, secp }
    }

    fn local(&self, network: &str, wif: &str) -> Option<R<Rc<LocalKey>>> {
        if !wif.starts_with(KEY_HANDLE_PREFIX) {
            return None;
        }
        Some(parse_network(network).and_then(|n| self.table.borrow_mut().resolve(wif, n)))
    }
}

impl SignBackend for HandleSigner {
    fn sign_tx(&mut self, network: &str, rawtx: &str, wif: &str, inputs: &[Utxo]) -> CallResult {
        match self.local(network, wif) {
            Some(key) => {
                let key = key?;
                localsign::sign_tx(&self.secp, &key, rawtx, inputs)
            }
            None => self.node.sign_tx(network, rawtx, wif, inputs),
        }
    }

    fn sign_psbt(&mut self, network: &str, wif: &str, psbt_hex: &str) -> CallResult {
        match self.local(network, wif) {
            Some(key) => {
                let key = key?;
                localsign::sign_psbt(&self.secp, &key, psbt_hex)
            }
            None => self.node.sign_psbt(network, wif, psbt_hex),
        }
    }
}

#[cfg(test)]
#[path = "keyvault_tests.rs"]
mod tests;
