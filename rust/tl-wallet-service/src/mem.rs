//! In-memory implementations of the service boundary traits, used by the tests and as a reference
//! for adapters. They hold no keys and never touch the network or disk.

use crate::amount::Amount;
use crate::nodecfg::RpcEndpoint;
use crate::service::{
    CallResult, ConfStore, KeyBackend, ListenerBackend, ListenerReply, NodeConnector,
    RelayerBackend, RpcBackend, RpcOutcome, SignBackend,
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
    /// Scripted node error (code, message) per method; takes precedence over `responses`.
    pub rpc_errors: BTreeMap<String, (i64, String)>,
    /// Every wallet-scoped call: (wallet, method, params).
    pub wallet_calls: Vec<(String, String, Vec<Value>)>,
}

#[derive(Clone, Default, Debug)]
pub struct MemRpc(pub Rc<RefCell<RpcState>>);

impl MemRpc {
    pub fn script(&self, method: &str, v: Value) {
        self.0.borrow_mut().responses.insert(method.into(), v);
    }

    pub fn script_error(&self, method: &str, code: i64, message: &str) {
        self.0
            .borrow_mut()
            .rpc_errors
            .insert(method.into(), (code, message.into()));
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
        if let Some((_, message)) = s.rpc_errors.get(method) {
            return Err(message.clone());
        }
        s.responses
            .get(method)
            .cloned()
            .ok_or_else(|| format!("{method}: not scripted"))
    }

    fn call_wallet(&mut self, wallet: &str, method: &str, params: &[Value]) -> RpcOutcome {
        self.0.borrow_mut().wallet_calls.push((
            wallet.to_string(),
            method.to_string(),
            params.to_vec(),
        ));
        self.call_detailed(method, params)
    }

    fn call_detailed(&mut self, method: &str, params: &[Value]) -> RpcOutcome {
        let scripted = self.0.borrow().rpc_errors.get(method).cloned();
        match scripted {
            Some((code, message)) => {
                self.0
                    .borrow_mut()
                    .calls
                    .push((method.to_string(), params.to_vec()));
                RpcOutcome::RpcError { code, message }
            }
            None => match self.call(method, params) {
                Ok(v) => RpcOutcome::Ok(v),
                Err(e) => RpcOutcome::Failed(e),
            },
        }
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

/// Key backend that counts `clear` calls (logout, stop-wallet-node).
#[derive(Clone, Default, Debug)]
pub struct CountingKeys(pub Rc<std::cell::Cell<usize>>);

impl KeyBackend for CountingKeys {
    fn new_mnemonic(&mut self, n: &str) -> Result<String, String> {
        MemKeys.new_mnemonic(n)
    }

    fn key_pair(&mut self, n: &str, m: &str, path: &str) -> CallResult {
        MemKeys.key_pair(n, m, path)
    }

    fn clear(&mut self) {
        self.0.set(self.0.get() + 1);
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

/// One request the in-memory listener saw.
#[derive(Clone, Debug, PartialEq)]
pub struct ListenerCall {
    pub method: String,
    pub endpoint: String,
    pub query: String,
    pub body: Option<Value>,
    pub timeout: std::time::Duration,
}

#[derive(Default, Debug)]
pub struct ListenerState {
    /// Scripted answer per `"<METHOD> <endpoint>"`; a missing entry is a refused connection.
    pub responses: BTreeMap<String, Result<ListenerReply, String>>,
    pub calls: Vec<ListenerCall>,
}

/// In-memory TradeLayer listener.
#[derive(Clone, Default, Debug)]
pub struct MemListener(pub Rc<RefCell<ListenerState>>);

impl MemListener {
    pub fn script(&self, method: &str, endpoint: &str, status: u16, body: Value) {
        self.0.borrow_mut().responses.insert(
            format!("{method} {endpoint}"),
            Ok(ListenerReply { status, body }),
        );
    }

    pub fn script_error(&self, method: &str, endpoint: &str, message: &str) {
        self.0
            .borrow_mut()
            .responses
            .insert(format!("{method} {endpoint}"), Err(message.into()));
    }

    pub fn calls_of(&self, endpoint: &str) -> Vec<ListenerCall> {
        self.0
            .borrow()
            .calls
            .iter()
            .filter(|c| c.endpoint == endpoint)
            .cloned()
            .collect()
    }

    pub fn total_calls(&self) -> usize {
        self.0.borrow().calls.len()
    }
}

impl ListenerBackend for MemListener {
    fn request(
        &mut self,
        method: &str,
        endpoint: &str,
        query: &str,
        body: Option<&Value>,
        timeout: std::time::Duration,
    ) -> Result<ListenerReply, String> {
        let mut s = self.0.borrow_mut();
        s.calls.push(ListenerCall {
            method: method.into(),
            endpoint: endpoint.into(),
            query: query.into(),
            body: body.cloned(),
            timeout,
        });
        match s.responses.get(&format!("{method} {endpoint}")) {
            Some(r) => r.clone(),
            None => Err("connect ECONNREFUSED 127.0.0.1:3000".into()),
        }
    }

    fn origin(&self) -> String {
        "http://127.0.0.1:3000".into()
    }
}
