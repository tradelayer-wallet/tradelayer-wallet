use super::*;
use crate::bip322::{b64_encode, challenge_psbt, decode_witness, sign_simple_wpkh, verify_simple};
use crate::legacy::keyvault::{KeyTable, LocalKey};
use bitcoin::secp256k1::SecretKey;
use bitcoin::{CompressedPublicKey, Script, Witness};
use tl_wallet_service::mem::{MemConnector, MemRpc};

const MSG: &str = "TradeLayer session authentication\nnonce=00ff\nexpires=1";

fn secret(n: u8) -> SecretKey {
    SecretKey::from_slice(&[n; 32]).unwrap()
}

fn signer_with(table: SharedKeys, node: &MemRpc) -> (LocalAuthSigner, Box<dyn RpcBackend>) {
    let slot = TapSlot::default();
    let mut tap = NodeTap::new(
        MemConnector {
            node: node.clone(),
            connected: Rc::default(),
        },
        slot.clone(),
    );
    let ep = RpcEndpoint {
        user: String::new(),
        password: String::new(),
        host: "127.0.0.1".into(),
        port: 1,
    };
    let held = tap.connect(&ep, true).unwrap();
    (
        LocalAuthSigner::new(table, Rc::new(Secp256k1::new()), slot),
        held,
    )
}

fn spk_of(net: Network, address: &str) -> ScriptBuf {
    Address::parse(net, address)
        .unwrap()
        .script_pubkey()
        .to_owned()
}

#[test]
fn a_tlk1_key_signs_in_rust_and_the_signature_verifies() {
    let secp = Rc::new(Secp256k1::new());
    let table = KeyTable::shared();
    let key = LocalKey::derive(&secp, Network::LtcTest, &[7u8; 64], "m/0'/0'/0'").unwrap();
    let address = key.address().to_string();
    table.borrow_mut().insert(key).unwrap();
    // No node is attached: the key never needs one.
    let (signer, _held) = signer_with(table.clone(), &MemRpc::default());
    let sig = signer.sign("LTCTEST", &address, MSG).unwrap();
    verify_simple(&spk_of(Network::LtcTest, &address), MSG.as_bytes(), &sig).unwrap();
    // Deterministic, and bound to the message.
    assert_eq!(signer.sign("LTCTEST", &address, MSG).unwrap(), sig);
    assert!(verify_simple(&spk_of(Network::LtcTest, &address), b"other", &sig).is_err());
    // The key belongs to LTCTEST: another network does not parse the address.
    assert!(signer.sign("LTC", &address, MSG).is_err());
    assert!(signer.sign("NOPE", &address, MSG).is_err());
    // A cleared table (UI logout) leaves nothing to sign with; with no node the error says so.
    table.borrow_mut().clear();
    assert_eq!(
        signer.sign("LTCTEST", &address, MSG).unwrap_err(),
        "getaddressinfo: not scripted",
        "the address was looked up in the node wallet instead"
    );
}

#[test]
fn unusable_challenges_and_addresses_are_refused_before_any_signing() {
    let node = MemRpc::default();
    let (signer, _held) = signer_with(KeyTable::shared(), &node);
    assert!(signer.sign("LTCTEST", "tltc1qxyz", MSG).is_err());
    let pk = CompressedPublicKey(secret(1).public_key(&Secp256k1::new()));
    let address = Address::for_account_key(Network::LtcTest, &pk)
        .encode()
        .unwrap();
    assert!(signer.sign("LTCTEST", &address, "").is_err());
    assert!(signer
        .sign("LTCTEST", &address, &"x".repeat(MAX_MESSAGE_BYTES + 1))
        .is_err());
    // A P2WSH address cannot log in.
    let p2wsh = Address::p2wsh(
        Network::LtcTest,
        ScriptBuf::new_op_return([1u8; 4]).as_script(),
    )
    .unwrap()
    .encode()
    .unwrap();
    assert_eq!(
        signer.sign("LTCTEST", &p2wsh, MSG).unwrap_err(),
        "this address type cannot log in to the orderbook"
    );
    assert_eq!(node.total_calls(), 0);
}

/// Script the node like Bitcoin Core would for `key`: `getaddressinfo`, and a
/// `walletprocesspsbt` answer holding the finalized challenge PSBT.
fn scripted_node(spk: &Script, address: &str, net_info: Value, key: &SecretKey) -> MemRpc {
    let secp = Secp256k1::new();
    let pk = CompressedPublicKey(key.public_key(&secp));
    let node = MemRpc::default();
    node.script("getaddressinfo", net_info.clone());
    let hints = hints_from(&net_info, &spk.to_owned());
    let mut psbt = challenge_psbt(spk, MSG.as_bytes(), &hints).unwrap();
    let sig = sign_simple_wpkh(spk, MSG.as_bytes(), &pk, |m| secp.sign_ecdsa(m, key)).unwrap();
    psbt.inputs[0].final_script_witness = Some(decode_witness(&sig).unwrap());
    node.script(
        "walletprocesspsbt",
        json!({"psbt": b64_encode(&psbt.serialize()), "complete": true}),
    );
    let _ = address;
    node
}

#[test]
fn a_node_wallet_p2wpkh_address_signs_the_challenge_psbt_with_its_origin() {
    let key = secret(1);
    let pk = CompressedPublicKey(key.public_key(&Secp256k1::new()));
    let address = Address::for_account_key(Network::LtcTest, &pk)
        .encode()
        .unwrap();
    let spk = spk_of(Network::LtcTest, &address);
    let info = json!({"ismine": true, "pubkey": pk.to_string(),
                      "hdmasterfingerprint": "aabbccdd", "hdkeypath": "m/84h/1h/0h/0/3"});
    let node = scripted_node(&spk, &address, info, &key);
    let (signer, _held) = signer_with(KeyTable::shared(), &node);
    let sig = signer.sign("LTCTEST", &address, MSG).unwrap();
    verify_simple(&spk, MSG.as_bytes(), &sig).unwrap();

    // What the node was asked.
    let calls = node.0.borrow().calls.clone();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0],
        ("getaddressinfo".to_string(), vec![json!(address)])
    );
    let (method, params) = &calls[1];
    assert_eq!(method, "walletprocesspsbt");
    assert_eq!(
        &params[1..],
        [json!(true), json!("ALL"), json!(true), json!(true)]
    );
    let sent =
        Psbt::deserialize(&bip322::b64_decode(params[0].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(
        sent.unsigned_tx,
        bip322::to_sign(&bip322::to_spend(&spk, MSG.as_bytes()))
    );
    let input = &sent.inputs[0];
    assert_eq!(input.witness_utxo.as_ref().unwrap().script_pubkey, spk);
    assert_eq!(
        input.witness_utxo.as_ref().unwrap().value,
        bitcoin::Amount::ZERO
    );
    let (fp, path) = &input.bip32_derivation[&pk.0];
    assert_eq!(fp.to_string(), "aabbccdd");
    assert_eq!(path.to_string(), "84'/1'/0'/0/3");
    assert!(input.final_script_witness.is_none() && input.partial_sigs.is_empty());
}

/// FE-speed labels the network Litecoin Testnet by default; a regtest node's wallet answers
/// regtest addresses (`bcrt1...` on Bitcoin Core), so the label must not decide the format.
#[test]
fn a_regtest_node_wallet_address_signs_under_the_ui_testnet_label() {
    let key = secret(3);
    let pk = CompressedPublicKey(key.public_key(&Secp256k1::new()));
    let address = Address::for_account_key(Network::BtcRegtest, &pk)
        .encode()
        .unwrap();
    assert!(address.starts_with("bcrt1"));
    let spk = spk_of(Network::BtcRegtest, &address);
    let info = json!({"ismine": true, "pubkey": pk.to_string(),
                      "hdmasterfingerprint": "aabbccdd", "hdkeypath": "m/84h/1h/0h/0/1"});
    let node = scripted_node(&spk, &address, info, &key);
    let (signer, _held) = signer_with(KeyTable::shared(), &node);
    let sig = signer.sign("LTCTEST", &address, MSG).unwrap();
    verify_simple(&spk, MSG.as_bytes(), &sig).unwrap();
    // The bech32 prefix decides without asking the node about its chain.
    assert!(!node
        .0
        .borrow()
        .calls
        .iter()
        .any(|(m, _)| m == "getblockchaininfo"));
}

/// A base58 address in a regtest format the label does not parse (Bitcoin Core regtest P2SH `2...`
/// under the Litecoin Testnet label) asks the node whether it runs regtest.
#[test]
fn a_base58_regtest_address_is_resolved_by_asking_the_node() {
    let btc_regtest_p2sh = Address::from_script(
        Network::BtcRegtest,
        &bitcoin::ScriptBuf::new_p2sh(
            &<bitcoin::ScriptHash as bitcoin::hashes::Hash>::from_byte_array([9u8; 20]),
        ),
    )
    .unwrap()
    .encode()
    .unwrap();
    let asked = std::cell::Cell::new(false);
    let net = address_network(Network::LtcTest, &btc_regtest_p2sh, || {
        asked.set(true);
        Some(Network::BtcRegtest)
    });
    assert!(asked.get());
    assert_eq!(net, Network::BtcRegtest);
    // Garbage never asks the node.
    let never = || -> Option<Network> { panic!("must not ask the node") };
    assert_eq!(
        address_network(Network::LtcTest, "not-an-address", never),
        Network::LtcTest
    );
}

#[test]
fn a_node_wallet_p2sh_p2wpkh_address_gets_its_redeem_script() {
    let key = secret(2);
    let pk = CompressedPublicKey(key.public_key(&Secp256k1::new()));
    let program = ScriptBuf::new_p2wpkh(&pk.wpubkey_hash());
    let spk = ScriptBuf::new_p2sh(&program.script_hash());
    let address = Address::from_script(Network::LtcTest, &spk)
        .unwrap()
        .encode()
        .unwrap();
    // Core reports the key of a wrapped address under `embedded`.
    let info = json!({"ismine": true, "embedded": {"pubkey": pk.to_string()},
                      "hdmasterfingerprint": "01020304", "hdkeypath": "m/49'/1'/0'/0/9"});
    let node = scripted_node(&spk, &address, info, &key);
    let (signer, _held) = signer_with(KeyTable::shared(), &node);
    let sig = signer.sign("LTCTEST", &address, MSG).unwrap();
    verify_simple(&spk, MSG.as_bytes(), &sig).unwrap();
    let params = node.0.borrow().calls[1].1.clone();
    let sent =
        Psbt::deserialize(&bip322::b64_decode(params[0].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(sent.inputs[0].redeem_script, Some(program));
    assert_eq!(sent.inputs[0].bip32_derivation.len(), 1);
}

#[test]
fn a_node_that_does_not_sign_or_tampers_is_an_error() {
    let key = secret(1);
    let pk = CompressedPublicKey(key.public_key(&Secp256k1::new()));
    let address = Address::for_account_key(Network::LtcTest, &pk)
        .encode()
        .unwrap();
    let spk = spk_of(Network::LtcTest, &address);
    let mine = json!({"ismine": true, "pubkey": pk.to_string()});

    // Not the wallet's address.
    let node = MemRpc::default();
    node.script("getaddressinfo", json!({"ismine": false}));
    let (signer, _held) = signer_with(KeyTable::shared(), &node);
    assert_eq!(
        signer.sign("LTCTEST", &address, MSG).unwrap_err(),
        "the address is not one of the wallet's keys"
    );
    assert_eq!(node.calls_of("walletprocesspsbt"), 0);

    // A locked wallet answers an unsigned PSBT.
    let unsigned = challenge_psbt(&spk, MSG.as_bytes(), &NodeHints::default()).unwrap();
    let node = MemRpc::default();
    node.script("getaddressinfo", mine.clone());
    node.script(
        "walletprocesspsbt",
        json!({"psbt": b64_encode(&unsigned.serialize()), "complete": false}),
    );
    let (signer, _held) = signer_with(KeyTable::shared(), &node);
    assert!(signer
        .sign("LTCTEST", &address, MSG)
        .unwrap_err()
        .contains("did not sign"));

    // A node that answers for another transaction.
    let mut other = challenge_psbt(&spk, b"another message", &NodeHints::default()).unwrap();
    other.inputs[0].final_script_witness =
        Some(Witness::from_slice(&[vec![1u8; 71], vec![2u8; 33]]));
    node.script(
        "walletprocesspsbt",
        json!({"psbt": b64_encode(&other.serialize()), "complete": true}),
    );
    assert_eq!(
        signer.sign("LTCTEST", &address, MSG).unwrap_err(),
        "the node changed the challenge transaction"
    );

    // Garbage and node errors.
    node.script("walletprocesspsbt", json!({"complete": true}));
    assert!(signer.sign("LTCTEST", &address, MSG).is_err());
    node.script("walletprocesspsbt", json!({"psbt": "!!!!"}));
    assert!(signer.sign("LTCTEST", &address, MSG).is_err());
    node.script_error(
        "walletprocesspsbt",
        -13,
        "Please enter the wallet passphrase",
    );
    assert_eq!(
        signer.sign("LTCTEST", &address, MSG).unwrap_err(),
        "Please enter the wallet passphrase"
    );
}

#[test]
fn a_p2pkh_address_is_signed_with_signmessage() {
    let pk = CompressedPublicKey(secret(3).public_key(&Secp256k1::new()));
    let spk = ScriptBuf::new_p2pkh(&pk.pubkey_hash());
    let address = Address::from_script(Network::LtcTest, &spk)
        .unwrap()
        .encode()
        .unwrap();
    let node = MemRpc::default();
    node.script("getaddressinfo", json!({"ismine": true}));
    let canned = b64_encode(&[32u8; 65]);
    node.script("signmessage", json!(canned));
    let (signer, _held) = signer_with(KeyTable::shared(), &node);
    assert_eq!(signer.sign("LTCTEST", &address, MSG).unwrap(), canned);
    let calls = node.0.borrow().calls.clone();
    assert_eq!(
        calls[1],
        ("signmessage".to_string(), vec![json!(address), json!(MSG)])
    );
    assert_eq!(node.calls_of("walletprocesspsbt"), 0);
    node.script("signmessage", json!(b64_encode(&[1u8; 10])));
    assert!(signer.sign("LTCTEST", &address, MSG).is_err());
    node.script("signmessage", json!(5));
    assert!(signer.sign("LTCTEST", &address, MSG).is_err());
}

#[test]
fn the_tap_serves_the_service_and_the_signer_from_one_connection() {
    let node = MemRpc::default();
    node.script("getblockchaininfo", json!({"blocks": 3}));
    let slot = TapSlot::default();
    // Before a connection exists the slot has no node.
    assert_eq!(slot.call("getblockchaininfo", &[]).unwrap_err(), NO_NODE);
    let mut tap = NodeTap::new(
        MemConnector {
            node: node.clone(),
            connected: Rc::default(),
        },
        slot.clone(),
    );
    let ep = RpcEndpoint {
        user: String::new(),
        password: String::new(),
        host: "127.0.0.1".into(),
        port: 1,
    };
    let mut service_side = tap.connect(&ep, false).unwrap();
    assert_eq!(
        service_side.call("getblockchaininfo", &[]).unwrap(),
        json!({"blocks": 3})
    );
    assert_eq!(
        slot.call("getblockchaininfo", &[]).unwrap(),
        json!({"blocks": 3})
    );
    assert_eq!(node.calls_of("getblockchaininfo"), 2);
    // When the service drops its connection (stop-wallet-node) the slot's handle expires.
    drop(service_side);
    assert_eq!(slot.call("getblockchaininfo", &[]).unwrap_err(), NO_NODE);
}

#[test]
fn jobs_run_on_the_installing_thread_and_without_a_signer_they_fail_plainly() {
    use std::sync::mpsc;
    // No signer installed on this thread.
    let (tx, rx) = mpsc::channel();
    run(SignJob {
        network: "LTCTEST".into(),
        address: "x".into(),
        message: MSG.into(),
        done: Box::new(move |r| {
            let _ = tx.send(r);
        }),
    });
    assert_eq!(rx.recv().unwrap().unwrap_err(), "signing is not available");

    // The queue signer: a thread that installs a signer, reports its key's address and serves one job.
    struct Q(mpsc::SyncSender<SignJob>);
    impl JobQueue for Q {
        fn submit(&self, job: SignJob) -> bool {
            self.0.try_send(job).is_ok()
        }
    }
    let (jtx, jrx) = mpsc::sync_channel::<SignJob>(1);
    let (atx, arx) = mpsc::channel::<String>();
    let worker = std::thread::spawn(move || {
        let secp = Rc::new(Secp256k1::new());
        let table = KeyTable::shared();
        let key = LocalKey::derive(&secp, Network::LtcTest, &[9u8; 64], "m/1'").unwrap();
        atx.send(key.address().to_string()).unwrap();
        table.borrow_mut().insert(key).unwrap();
        install(LocalAuthSigner::new(table, secp, TapSlot::default()));
        run(jrx.recv().unwrap());
    });
    let address = arx.recv().unwrap();
    let q = QueueSigner(Q(jtx));
    let sig = q.sign("LTCTEST", &address, MSG).unwrap();
    verify_simple(&spk_of(Network::LtcTest, &address), MSG.as_bytes(), &sig).unwrap();
    worker.join().unwrap();
    // The thread is gone: nobody takes the job and the signer reports it instead of hanging.
    let (dead_tx, dead_rx) = mpsc::sync_channel::<SignJob>(1);
    drop(dead_rx);
    assert_eq!(
        QueueSigner(Q(dead_tx))
            .sign("LTCTEST", &address, MSG)
            .unwrap_err(),
        "the wallet bridge is busy"
    );
}

// ------------------------------------------------------------------ Bitcoin Core regtest

struct Bitcoind {
    child: std::process::Child,
    dir: std::path::PathBuf,
}

impl Drop for Bitcoind {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// The node wallet signs the challenge for every address type, and the Rust verifier (BIP-322
/// semantics, as the server's) accepts it. Needs a Bitcoin Core with a descriptor wallet:
/// `TL_BITCOIND=<path to bitcoind>` (default: the Windows install of 31.1). Run with
/// `cargo test --locked -- --ignored regtest_node_wallet`.
#[test]
#[ignore = "needs Bitcoin Core; set TL_BITCOIND"]
fn regtest_node_wallet_signatures_verify() {
    use crate::legacy::RpcClient;
    let exe = std::env::var("TL_BITCOIND").unwrap_or_else(|_| {
        "C:/Users/patri/AppData/Local/Programs/BitcoinCore/bitcoin-31.1/bin/bitcoind.exe".into()
    });
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("tl-auth-regtest-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let (rpc_port, p2p_port) = (free_port(), free_port());
    let child = std::process::Command::new(exe)
        .arg("-regtest")
        .arg(format!("-datadir={}", dir.display()))
        .arg(format!("-rpcport={rpc_port}"))
        .arg(format!("-port={p2p_port}"))
        .arg("-rpcuser=tlauth")
        .arg("-rpcpassword=tlauth-throwaway")
        .args(["-listen=0", "-dnsseed=0", "-fixedseeds=0", "-server=1"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("bitcoind starts");
    let _node = Bitcoind { child, dir };

    let url = format!("http://127.0.0.1:{rpc_port}");
    let mut rpc = RpcClient::new(&url, "tlauth", "tlauth-throwaway").unwrap();
    let end = std::time::Instant::now() + Duration::from_secs(90);
    while rpc.call("getblockchaininfo", &[]).is_err() {
        assert!(std::time::Instant::now() < end, "bitcoind never answered");
        std::thread::sleep(Duration::from_millis(250));
    }
    rpc.call("createwallet", &[json!("auth")]).unwrap();
    let mut addresses = Vec::new();
    for t in ["bech32", "p2sh-segwit", "legacy", "bech32m"] {
        let a = rpc.call("getnewaddress", &[json!(""), json!(t)]).unwrap();
        addresses.push((t, a.as_str().unwrap().to_string()));
    }

    struct Once(std::cell::RefCell<Option<RpcClient>>);
    impl NodeConnector for Once {
        fn connect(&mut self, _: &RpcEndpoint, _: bool) -> Result<Box<dyn RpcBackend>, String> {
            Ok(Box::new(self.0.take().ok_or("used")?))
        }
    }
    let slot = TapSlot::default();
    let mut tap = NodeTap::new(
        Once(std::cell::RefCell::new(Some(
            RpcClient::new(&url, "tlauth", "tlauth-throwaway").unwrap(),
        ))),
        slot.clone(),
    );
    let ep = RpcEndpoint {
        user: String::new(),
        password: String::new(),
        host: "127.0.0.1".into(),
        port: rpc_port,
    };
    let _held = tap.connect(&ep, false).unwrap();
    let signer = LocalAuthSigner::new(KeyTable::shared(), Rc::new(Secp256k1::new()), slot);

    for (kind, address) in &addresses {
        let sig = signer
            .sign("BTCREGTEST", address, MSG)
            .unwrap_or_else(|e| panic!("{kind} {address}: {e}"));
        let spk = spk_of_any(address);
        if *kind == "legacy" {
            let a = Address::parse(Network::BtcRegtest, address).unwrap();
            assert!(
                tl_wallet_core::message::verify_message(&a, MSG.as_bytes(), &sig).unwrap(),
                "{kind}: BIP-137 signature does not verify"
            );
            assert!(!tl_wallet_core::message::verify_message(&a, b"other", &sig).unwrap());
        } else {
            verify_simple(&spk, MSG.as_bytes(), &sig).unwrap_or_else(|e| panic!("{kind}: {e}"));
            assert!(verify_simple(&spk, b"other", &sig).is_err(), "{kind}");
        }
        eprintln!("regtest {kind} {address}: signature verifies");
    }
    // An address the wallet does not own is refused.
    let stranger = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
    assert_eq!(
        signer.sign("BTCREGTEST", stranger, MSG).unwrap_err(),
        "the address is not one of the wallet's keys"
    );
    let _ = rpc.call("stop", &[]);
}

fn spk_of_any(address: &str) -> ScriptBuf {
    script_of(Network::BtcRegtest, address).unwrap()
}
