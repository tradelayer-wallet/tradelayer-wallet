//! Scripted node, fake clock and deterministic entropy shared by the integration tests.
#![allow(dead_code)]

use bitcoin::consensus::encode::deserialize_hex;
use bitcoin::Transaction;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use tl_desktop_core::{
    Balance, Clock, Config, CoreError, Entropy, InMemoryStore, NodeError, NodeRpc, ScanResult,
    ScannedUtxo, Wallet,
};
use tl_wallet_core::keys::{Account, ChangeMode, ImportedMnemonic};
use tl_wallet_core::vault::Kdf;
use tl_wallet_core::Network;

pub const PHRASE: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
pub const OTHER_PHRASE: &str =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";
pub const PASSWORD: &str = "correct horse battery staple";

#[derive(Default)]
pub struct NodeState {
    pub chain: String,
    pub height: u64,
    pub utxos: Vec<ScannedUtxo>,
    pub fee_estimate: Option<u64>,
    pub fee_calls: Vec<u16>,
    pub chain_calls: usize,
    pub scan_calls: usize,
    pub descriptors: Vec<Vec<String>>,
    /// Raw transactions the node accepted.
    pub broadcasts: Vec<String>,
    /// Every call to `broadcast`, accepted or not.
    pub broadcast_attempts: usize,
    pub broadcast_error: Option<NodeError>,
    pub reply_txid: Option<String>,
    pub chain_error: bool,
}

#[derive(Clone)]
pub struct MockNode(pub Rc<RefCell<NodeState>>);

impl MockNode {
    pub fn new(chain: &str) -> Self {
        MockNode(Rc::new(RefCell::new(NodeState {
            chain: chain.to_string(),
            height: 200,
            ..NodeState::default()
        })))
    }
    pub fn state(&self) -> std::cell::RefMut<'_, NodeState> {
        self.0.borrow_mut()
    }
}

impl NodeRpc for MockNode {
    fn chain(&mut self) -> Result<String, NodeError> {
        let mut s = self.0.borrow_mut();
        s.chain_calls += 1;
        if s.chain_error {
            return Err(NodeError::Transport("down".into()));
        }
        Ok(s.chain.clone())
    }
    fn scan(&mut self, descriptors: &[String]) -> Result<ScanResult, NodeError> {
        let mut s = self.0.borrow_mut();
        s.scan_calls += 1;
        s.descriptors.push(descriptors.to_vec());
        Ok(ScanResult {
            height: s.height,
            utxos: s.utxos.clone(),
        })
    }
    fn fee_rate_sat_per_vb(&mut self, conf_target: u16) -> Result<Option<u64>, NodeError> {
        let mut s = self.0.borrow_mut();
        s.fee_calls.push(conf_target);
        Ok(s.fee_estimate)
    }
    fn broadcast(&mut self, raw_tx_hex: &str) -> Result<String, NodeError> {
        let mut s = self.0.borrow_mut();
        s.broadcast_attempts += 1;
        if let Some(e) = s.broadcast_error.clone() {
            return Err(e);
        }
        s.broadcasts.push(raw_tx_hex.to_string());
        if let Some(t) = s.reply_txid.clone() {
            return Ok(t);
        }
        let tx: Transaction = deserialize_hex(raw_tx_hex).map_err(|_| NodeError::Rpc {
            code: -22,
            message: "TX decode failed".into(),
        })?;
        Ok(tx.compute_txid().to_string())
    }
}

#[derive(Clone)]
pub struct TestClock(pub Rc<Cell<u64>>);

impl TestClock {
    pub fn new(start: u64) -> Self {
        TestClock(Rc::new(Cell::new(start)))
    }
    pub fn set(&self, ms: u64) {
        self.0.set(ms);
    }
    pub fn advance(&self, ms: u64) {
        self.0.set(self.0.get() + ms);
    }
}

impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}

/// Deterministic stream; every call advances it, so ids and salts never repeat.
pub struct SeqEntropy(pub u64);

impl Entropy for SeqEntropy {
    fn fill(&mut self, buf: &mut [u8]) -> Result<(), CoreError> {
        for b in buf.iter_mut() {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            *b = (self.0 >> 33) as u8;
        }
        Ok(())
    }
}

pub struct FailingEntropy;

impl Entropy for FailingEntropy {
    fn fill(&mut self, _buf: &mut [u8]) -> Result<(), CoreError> {
        Err(CoreError::Entropy)
    }
}

pub type TestWallet = Wallet<MockNode, InMemoryStore, TestClock, SeqEntropy>;

pub fn config(net: Network) -> Config {
    let mut c = Config::new(net);
    c.kdf = Kdf::FLOOR_SCRYPT;
    c
}

pub fn chain_of(net: Network) -> &'static str {
    match net {
        Network::BtcRegtest | Network::LtcRegtest => "regtest",
        Network::BtcTest | Network::LtcTest => "test",
        _ => "main",
    }
}

pub struct Harness {
    pub wallet: TestWallet,
    pub node: MockNode,
    pub clock: TestClock,
    pub net: Network,
    next_utxo: u64,
}

impl Harness {
    pub fn new(net: Network) -> Self {
        Self::with_config(config(net))
    }

    pub fn with_config(cfg: Config) -> Self {
        let net = cfg.network;
        let node = MockNode::new(chain_of(net));
        let clock = TestClock::new(1_000_000);
        let wallet = Wallet::new(
            cfg,
            node.clone(),
            InMemoryStore::new(),
            clock.clone(),
            SeqEntropy(7),
        );
        Harness {
            wallet,
            node,
            clock,
            net,
            next_utxo: 0,
        }
    }

    /// A regtest wallet that already imported `PHRASE` and is unlocked.
    pub fn unlocked(net: Network) -> Self {
        let mut h = Self::new(net);
        h.wallet.import(PHRASE, PASSWORD).unwrap();
        h
    }

    fn account(&self, phrase: &str) -> Account {
        let m = ImportedMnemonic::parse_phrase(phrase).unwrap();
        Account::from_mnemonic(&m, self.net, ChangeMode::InternalChain).unwrap()
    }

    pub fn receive_script_hex(&self) -> String {
        self.account(PHRASE)
            .receive_address()
            .script_pubkey()
            .to_hex_string()
    }

    pub fn change_script_hex(&self) -> String {
        self.account(PHRASE)
            .change_address()
            .script_pubkey()
            .to_hex_string()
    }

    pub fn change_script(&self) -> bitcoin::ScriptBuf {
        self.account(PHRASE)
            .change_address()
            .script_pubkey()
            .to_owned()
    }

    /// An address of the same network that belongs to nobody in the test.
    pub fn other_address(&self) -> String {
        self.account(OTHER_PHRASE)
            .receive_address()
            .encode()
            .unwrap()
    }

    pub fn other_script(&self) -> bitcoin::ScriptBuf {
        self.account(OTHER_PHRASE)
            .receive_address()
            .script_pubkey()
            .to_owned()
    }

    pub fn utxo(&mut self, script_hex: String, sats: u64) -> ScannedUtxo {
        self.next_utxo += 1;
        ScannedUtxo {
            txid: format!("{:064x}", self.next_utxo),
            vout: 0,
            script_pubkey_hex: script_hex,
            amount_sats: sats,
            height: 150,
            coinbase: false,
        }
    }

    /// Add confirmed UTXOs paying the receive address.
    pub fn fund(&mut self, amounts: &[u64]) {
        for a in amounts {
            let hex = self.receive_script_hex();
            let u = self.utxo(hex, *a);
            self.node.state().utxos.push(u);
        }
    }

    pub fn balance(&mut self) -> Balance {
        self.wallet.balance().unwrap()
    }
}
