//! Signing the orderbook login challenge, on the `legacy` thread that owns the keys and the node
//! connection ([`crate::obauth`] asks for it through a job on that thread's queue).
//!
//! * A `tlk1:` key (an address derived in Rust, held in the [`KeyTable`](crate::legacy::keyvault))
//!   signs BIP-322 simple in Rust ([`crate::bip322::sign_simple_wpkh`]). Its address is P2SH-P2WPKH.
//! * Any other address must belong to the node wallet (`getaddressinfo`: `ismine`). A P2WPKH,
//!   P2SH-P2WPKH or P2TR address gets the BIP-322 `to_sign` PSBT ([`crate::bip322::challenge_psbt`]:
//!   `witness_utxo` is the virtual output, plus the BIP-32 origin from `getaddressinfo`
//!   `hdmasterfingerprint`/`hdkeypath` and the redeem script of a P2SH address) and the node signs it
//!   with `walletprocesspsbt`; the signature is the witness of the finalized input. A P2PKH address
//!   has no witness: the node's `signmessage` produces the BIP-137 signature.
//!
//! The node is reached through [`NodeTap`], a connector wrapper that keeps a second weak handle on
//! the connection the service holds, so signing uses the node the UI started and calls no method
//! that the page's `rpc-call` allowlist would have to admit. No private key leaves the key table or
//! the node: the only outputs are signatures.

use crate::bip322::{self, Kind, NodeHints};
use crate::legacy::keyvault::SharedKeys;
use crate::obauth::AuthSigner;
use bitcoin::bip32::{DerivationPath, Fingerprint};
use bitcoin::hex::FromHex;
use bitcoin::psbt::Psbt;
use bitcoin::secp256k1::{All, PublicKey, Secp256k1};
use bitcoin::{CompressedPublicKey, ScriptBuf};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::rc::{Rc, Weak};
use std::str::FromStr;
use std::time::Duration;
use tl_wallet_core::{Address, Network};
use tl_wallet_service::nodecfg::RpcEndpoint;
use tl_wallet_service::service::{CallResult, NodeConnector, RpcBackend, RpcOutcome};

/// How long [`QueueSigner`] waits for the `legacy` thread.
pub const SIGN_WAIT: Duration = Duration::from_secs(5);
const MAX_MESSAGE_BYTES: usize = 1024;
const NO_NODE: &str = "No RPC Client initialized";

type R<T> = Result<T, String>;
type Shared = Rc<RefCell<Box<dyn RpcBackend>>>;
type WeakShared = Weak<RefCell<Box<dyn RpcBackend>>>;

// ------------------------------------------------------------------ node access

/// Weak handle to the node connection the service holds.
#[derive(Clone, Default)]
pub struct TapSlot(Rc<RefCell<WeakShared>>);

impl TapSlot {
    fn set(&self, node: &Shared) {
        *self.0.borrow_mut() = Rc::downgrade(node);
    }

    fn call(&self, method: &str, params: &[Value]) -> CallResult {
        let node = self.0.borrow().upgrade().ok_or(NO_NODE)?;
        let mut client = node
            .try_borrow_mut()
            .map_err(|_| "node client busy".to_string())?;
        client.call(method, params)
    }
}

/// Forwards to the connection shared with the slot.
struct TapRpc(Shared);

impl RpcBackend for TapRpc {
    fn call(&mut self, method: &str, params: &[Value]) -> CallResult {
        self.0
            .try_borrow_mut()
            .map_err(|_| "node client busy".to_string())?
            .call(method, params)
    }

    fn call_detailed(&mut self, method: &str, params: &[Value]) -> RpcOutcome {
        match self.0.try_borrow_mut() {
            Ok(mut c) => c.call_detailed(method, params),
            Err(_) => RpcOutcome::Failed("node client busy".into()),
        }
    }

    fn call_wallet(&mut self, wallet: &str, method: &str, params: &[Value]) -> RpcOutcome {
        match self.0.try_borrow_mut() {
            Ok(mut c) => c.call_wallet(wallet, method, params),
            Err(_) => RpcOutcome::Failed("node client busy".into()),
        }
    }
}

/// Wraps a [`NodeConnector`]: each connection it builds is also reachable through the slot.
pub struct NodeTap<C: NodeConnector> {
    inner: C,
    slot: TapSlot,
}

impl<C: NodeConnector> NodeTap<C> {
    pub fn new(inner: C, slot: TapSlot) -> NodeTap<C> {
        NodeTap { inner, slot }
    }
}

impl<C: NodeConnector> NodeConnector for NodeTap<C> {
    fn connect(&mut self, ep: &RpcEndpoint, testnet: bool) -> Result<Box<dyn RpcBackend>, String> {
        let shared: Shared = Rc::new(RefCell::new(self.inner.connect(ep, testnet)?));
        self.slot.set(&shared);
        Ok(Box::new(TapRpc(shared)))
    }
}

// ------------------------------------------------------------------ the signer

/// Signs challenges with the key table and the node wallet. Lives on the `legacy` thread.
pub struct LocalAuthSigner {
    table: SharedKeys,
    secp: Rc<Secp256k1<All>>,
    node: TapSlot,
}

fn flag(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

/// The script of `address` on `net`: P2PKH, P2SH, P2WPKH, or a taproot (witness v1) address,
/// which the wallet core does not parse.
fn script_of(net: Network, address: &str) -> R<ScriptBuf> {
    match Address::parse(net, address) {
        Ok(a) => Ok(a.script_pubkey().to_owned()),
        Err(first) => {
            let hrp = net.params().bech32_hrp.ok_or(first.to_string())?;
            if address.is_ascii() && address.len() <= 100 {
                if let Ok((got, version, program)) = bitcoin::bech32::segwit::decode(address) {
                    if got.to_lowercase() == hrp && version.to_u8() == 1 && program.len() == 32 {
                        let mut s = vec![0x51, 0x20];
                        s.extend_from_slice(&program);
                        return Ok(ScriptBuf::from_bytes(s));
                    }
                }
            }
            Err(format!("address: {first}"))
        }
    }
}

/// `getaddressinfo` fields from the address itself or its `embedded` script.
fn info_str<'a>(info: &'a Value, k: &str) -> Option<&'a str> {
    info.get(k)
        .and_then(Value::as_str)
        .or_else(|| info.get("embedded")?.get(k)?.as_str())
}

/// The BIP-32 origin and redeem script the node wallet may need; anything unparsable is left out
/// (the node can still find its key by the script).
fn hints_from(info: &Value, spk: &ScriptBuf) -> NodeHints {
    let pubkey = info_str(info, "pubkey").and_then(|h| PublicKey::from_str(h).ok());
    let origin = (|| {
        let pk = pubkey?;
        let fp = <[u8; 4]>::from_hex(info_str(info, "hdmasterfingerprint")?).ok()?;
        let path = DerivationPath::from_str(info_str(info, "hdkeypath")?).ok()?;
        Some((pk, Fingerprint::from(fp), path))
    })();
    let redeem_script = pubkey.and_then(|pk| {
        let program = ScriptBuf::new_p2wpkh(&CompressedPublicKey(pk).wpubkey_hash());
        (ScriptBuf::new_p2sh(&program.script_hash()) == *spk).then_some(program)
    });
    NodeHints {
        origin,
        redeem_script,
    }
}

/// The network whose format `address` is in. FE-speed labels the network Litecoin Testnet by
/// default, but a regtest node's wallet answers regtest addresses: a `bcrt1`/`rltc1` bech32 prefix
/// says so by itself, and a well-formed base58 address the label does not parse asks the node
/// (`regtest`) whether it runs regtest. Anything else keeps the label, so malformed input is refused
/// by the caller without a node call.
fn address_network(
    label: Network,
    address: &str,
    regtest: impl FnOnce() -> Option<Network>,
) -> Network {
    let lower = address.to_ascii_lowercase();
    if lower.starts_with("bcrt1") {
        return Network::BtcRegtest;
    }
    if lower.starts_with("rltc1") {
        return Network::LtcRegtest;
    }
    if script_of(label, address).is_ok() || bitcoin::base58::decode_check(address).is_err() {
        return label;
    }
    regtest().unwrap_or(label)
}

impl LocalAuthSigner {
    pub fn new(table: SharedKeys, secp: Rc<Secp256k1<All>>, node: TapSlot) -> LocalAuthSigner {
        LocalAuthSigner { table, secp, node }
    }

    pub fn sign(&self, network: &str, address: &str, message: &str) -> R<String> {
        if message.is_empty() || message.len() > MAX_MESSAGE_BYTES {
            return Err("the challenge has an unusable size".into());
        }
        let label = Network::parse(network).map_err(|_| "unknown network".to_string())?;
        let net = address_network(label, address, || {
            crate::nodewallet::regtest_override(|m| self.node.call(m, &[]).ok())
        });
        let spk = script_of(net, address)?;
        let key = self.table.borrow_mut().by_address(address, net);
        if let Some(key) = key {
            return match bip322::classify(&spk) {
                Kind::P2sh => {
                    bip322::sign_simple_wpkh(&spk, message.as_bytes(), &key.compressed(), |m| {
                        key.sign_digest(&self.secp, m)
                    })
                }
                _ => Err("the key's address type has no orderbook signature".into()),
            };
        }
        self.sign_with_node(&spk, address, message)
    }

    fn sign_with_node(&self, spk: &ScriptBuf, address: &str, message: &str) -> R<String> {
        let kind = bip322::classify(spk);
        if !matches!(kind, Kind::P2pkh | Kind::P2sh | Kind::P2wpkh | Kind::P2tr) {
            return Err("this address type cannot log in to the orderbook".into());
        }
        let info = self.node.call("getaddressinfo", &[json!(address)])?;
        if !flag(&info, "ismine") {
            return Err("the address is not one of the wallet's keys".into());
        }
        if kind == Kind::P2pkh {
            // BIP-137: the node signs the message under its own magic.
            let r = self
                .node
                .call("signmessage", &[json!(address), json!(message)])?;
            let sig = r.as_str().ok_or("signmessage returned no signature")?;
            return match bip322::b64_decode(sig) {
                Ok(raw) if raw.len() == 65 => Ok(sig.to_string()),
                _ => Err("signmessage returned an unusable signature".into()),
            };
        }
        let psbt = bip322::challenge_psbt(spk, message.as_bytes(), &hints_from(&info, spk))?;
        let sighash = if kind == Kind::P2tr { "DEFAULT" } else { "ALL" };
        let r = self.node.call(
            "walletprocesspsbt",
            &[
                json!(bip322::b64_encode(&psbt.serialize())),
                json!(true),
                json!(sighash),
                json!(true),
                json!(true),
            ],
        )?;
        let out = r
            .get("psbt")
            .and_then(Value::as_str)
            .ok_or("walletprocesspsbt returned no PSBT")?;
        let raw = bip322::b64_decode(out).map_err(|_| "walletprocesspsbt returned a bad PSBT")?;
        let signed =
            Psbt::deserialize(&raw).map_err(|_| "walletprocesspsbt returned a bad PSBT")?;
        if signed.unsigned_tx != psbt.unsigned_tx {
            return Err("the node changed the challenge transaction".into());
        }
        bip322::witness_of_signed_psbt(&signed)
    }
}

// ------------------------------------------------------------------ the legacy thread's side

thread_local! {
    static SIGNER: RefCell<Option<LocalAuthSigner>> = const { RefCell::new(None) };
}

/// Install the signer on the calling (`legacy`) thread.
pub fn install(signer: LocalAuthSigner) {
    SIGNER.with(|s| *s.borrow_mut() = Some(signer));
}

/// A request to sign, queued to the `legacy` thread.
pub struct SignJob {
    pub network: String,
    pub address: String,
    pub message: String,
    pub done: Box<dyn FnOnce(R<String>) + Send>,
}

/// Run a job on the thread that called [`install`].
pub fn run(job: SignJob) {
    let r = SIGNER.with(|s| match &*s.borrow() {
        Some(signer) => signer.sign(&job.network, &job.address, &job.message),
        None => Err("signing is not available".to_string()),
    });
    (job.done)(r);
}

/// What [`QueueSigner`] needs of the `legacy` thread's queue.
pub trait JobQueue: Send + Sync {
    /// Queue the job; `false` when the queue is full or gone.
    fn submit(&self, job: SignJob) -> bool;
}

/// [`AuthSigner`] that hands the work to the `legacy` thread and waits for the answer.
pub struct QueueSigner<Q: JobQueue>(pub Q);

impl<Q: JobQueue> AuthSigner for QueueSigner<Q> {
    fn sign(&self, network: &str, address: &str, message: &str) -> R<String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let job = SignJob {
            network: network.to_string(),
            address: address.to_string(),
            message: message.to_string(),
            done: Box::new(move |r| {
                let _ = tx.send(r);
            }),
        };
        if !self.0.submit(job) {
            return Err("the wallet bridge is busy".into());
        }
        rx.recv_timeout(SIGN_WAIT)
            .map_err(|_| "the wallet did not answer in time".to_string())?
    }
}

#[cfg(test)]
#[path = "authsign_tests.rs"]
mod tests;
