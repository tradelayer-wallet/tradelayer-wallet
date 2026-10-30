//! In-memory implementations of the service boundary traits, used by the tests and as a reference
//! for adapters. They hold no keys and never touch the network or disk.

use crate::amount::Amount;
use crate::nodecfg::RpcEndpoint;
use crate::service::{
    CallResult, ConfStore, KeyBackend, NodeConnector, RelayerBackend, RpcBackend, SignBackend,
};
use crate::txbuilder::Utxo;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

#[derive(Default, Debug)]
pub struct RpcState {
    /// Scripted result per method.
    pub responses: BTreeMap<String, Value>,
    /// Every call made, in order.
    pub calls: Vec<(String, Vec<Value>)>,
}

#[derive(Clone, Default, Debug)]
pub struct MemRpc(pub Rc<RefCell<RpcState>>);

impl MemRpc {
    pub fn script(&self, method: &str, v: Value) {
        self.0.borrow_mut().responses.insert(method.into(), v);
    }

    pub fn calls_of(&self, method: &str) -> usize {
        self.0
            .borrow()
            .calls
            .iter()
            .filter(|(m, _)| m == method)
            .count()
    }

    pub fn total_calls(&self) -> usize {
        self.0.borrow().calls.len()
    }
}

impl RpcBackend for MemRpc {
    fn call(&mut self, method: &str, params: &[Value]) -> CallResult {
        let mut s = self.0.borrow_mut();
        s.calls.push((method.to_string(), params.to_vec()));
        s.responses
            .get(method)
            .cloned()
            .ok_or_else(|| format!("{method}: not scripted"))
    }
}

#[derive(Clone, Default, Debug)]
pub struct MemRelayer(pub MemRpc);

impl RelayerBackend for MemRelayer {
    fn call(&mut self, _base_url: &str, method: &str, params: &[Value]) -> CallResult {
        self.0.call(method, params)
    }
}

#[derive(Clone, Default, Debug)]
pub struct MemKeys;

impl KeyBackend for MemKeys {
    fn new_mnemonic(&mut self, _network: &str) -> Result<String, String> {
        Ok("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about".into())
    }

    fn key_pair(&mut self, _network: &str, _mnemonic: &str, path: &str) -> CallResult {
        // Synthetic, clearly fake material: no real derivation happens here.
        Ok(json!({
            "address": format!("synthetic-{path}"),
            "privkey": "00",
            "pubkey": "02",
            "wif": "synthetic-wif"
        }))
    }
}

#[derive(Clone, Default, Debug)]
pub struct SignLog {
    pub signed_tx: Vec<String>,
    pub signed_psbt: Vec<String>,
}

#[derive(Clone, Default, Debug)]
pub struct MemSigner(pub Rc<RefCell<SignLog>>);

impl SignBackend for MemSigner {
    fn sign_tx(&mut self, _n: &str, rawtx: &str, _wif: &str, _inputs: &[Utxo]) -> CallResult {
        self.0.borrow_mut().signed_tx.push(rawtx.to_string());
        Ok(json!({ "signedHex": "00", "isValid": true, "isFinished": true }))
    }

    fn sign_psbt(&mut self, _n: &str, _wif: &str, psbt_hex: &str) -> CallResult {
        self.0.borrow_mut().signed_psbt.push(psbt_hex.to_string());
        Ok(json!({ "psbtHex": psbt_hex, "isFinished": false }))
    }
}

#[derive(Default, Debug)]
pub struct StoreState {
    pub dirs: BTreeSet<String>,
    pub files: BTreeMap<String, String>,
}

#[derive(Clone, Default, Debug)]
pub struct MemStore(pub Rc<RefCell<StoreState>>);

impl ConfStore for MemStore {
    fn dir_exists(&self, dir: &str) -> bool {
        self.0.borrow().dirs.contains(dir)
    }

    fn file_exists(&self, path: &str) -> bool {
        self.0.borrow().files.contains_key(path)
    }

    fn read(&self, path: &str) -> Option<String> {
        self.0.borrow().files.get(path).cloned()
    }

    fn write_new(&mut self, path: &str, contents: &str) -> Result<(), String> {
        let mut s = self.0.borrow_mut();
        if s.files.contains_key(path) {
            return Err("exists".into());
        }
        s.files.insert(path.into(), contents.into());
        Ok(())
    }
}

#[derive(Clone, Default, Debug)]
pub struct MemConnector {
    pub node: MemRpc,
    pub connected: Rc<RefCell<Vec<RpcEndpoint>>>,
}

impl NodeConnector for MemConnector {
    fn connect(&mut self, ep: &RpcEndpoint, _testnet: bool) -> Result<Box<dyn RpcBackend>, String> {
        self.connected.borrow_mut().push(ep.clone());
        Ok(Box::new(self.node.clone()))
    }
}

/// Convenience for tests: coin amount from a decimal string.
pub fn coin(s: &str) -> Amount {
    Amount::parse_coin(s).unwrap_or(Amount::ZERO)
}
