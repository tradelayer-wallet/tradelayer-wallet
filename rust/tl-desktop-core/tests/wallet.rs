//! Session, chain-binding, scan and send behaviour of `Wallet` against a scripted node.

mod common;

use bitcoin::consensus::encode::deserialize_hex;
use bitcoin::Transaction;
use common::*;
use tl_desktop_core::{expected_chains, CoreError, NodeError, Wallet, DESKTOP_ORIGIN};
use tl_wallet_core::vault::VaultError;
use tl_wallet_core::{Error as WalletError, Network};

fn decode(raw: &str) -> Transaction {
    deserialize_hex(raw).expect("raw tx decodes")
}

// ------------------------------------------------------------------ vault session

#[test]
fn create_returns_a_twelve_word_phrase_and_unlocks() {
    let mut h = Harness::new(Network::BtcRegtest);
    assert!(!h.wallet.status().has_vault);
    let phrase = h.wallet.create(PASSWORD).unwrap();
    assert_eq!(phrase.split_whitespace().count(), 12);
    let st = h.wallet.status();
    assert!(st.has_vault && st.unlocked && st.chain_matches);
    assert_eq!(st.network_id, "BTCREGTEST");
    assert!(h.wallet.receive_address().unwrap().starts_with("bcrt1"));
}

#[test]
fn create_phrase_restores_the_same_wallet() {
    let mut a = Harness::new(Network::BtcRegtest);
    let phrase = a.wallet.create(PASSWORD).unwrap();
    let mut b = Harness::new(Network::BtcRegtest);
    b.wallet.import(&phrase, "another password").unwrap();
    assert_eq!(
        a.wallet.receive_address().unwrap(),
        b.wallet.receive_address().unwrap()
    );
}

#[test]
fn lock_unlock_and_wrong_password() {
    let mut h = Harness::new(Network::BtcRegtest);
    h.wallet.import(PHRASE, PASSWORD).unwrap();
    let addr = h.wallet.receive_address().unwrap();
    h.wallet.lock();
    let st = h.wallet.status();
    assert!(st.has_vault && !st.unlocked);
    assert_eq!(h.wallet.receive_address(), Err(CoreError::Locked));

    assert_eq!(h.wallet.unlock("wrong"), Err(CoreError::WrongPassword));
    assert_eq!(
        h.wallet.unlock(""),
        Err(CoreError::Vault(VaultError::EmptyPassword))
    );
    assert!(!h.wallet.status().unlocked);

    h.wallet.unlock(PASSWORD).unwrap();
    assert_eq!(h.wallet.receive_address().unwrap(), addr);
}

#[test]
fn unlock_without_a_vault_is_a_typed_error() {
    let mut h = Harness::new(Network::BtcRegtest);
    assert_eq!(h.wallet.unlock(PASSWORD), Err(CoreError::NoVault));
}

#[test]
fn create_and_import_never_overwrite_a_vault() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    let addr = h.wallet.receive_address().unwrap();
    assert_eq!(h.wallet.create("pw2"), Err(CoreError::VaultExists));
    assert_eq!(
        h.wallet.import(OTHER_PHRASE, "pw2"),
        Err(CoreError::VaultExists)
    );
    h.wallet.lock();
    h.wallet.unlock(PASSWORD).unwrap();
    assert_eq!(h.wallet.receive_address().unwrap(), addr);
}

#[test]
fn import_rejects_a_bad_phrase_and_writes_nothing() {
    let mut h = Harness::new(Network::BtcRegtest);
    let bad = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
    assert!(matches!(
        h.wallet.import(bad, PASSWORD),
        Err(CoreError::Wallet(WalletError::InvalidMnemonic(_)))
    ));
    assert!(matches!(
        h.wallet.import("abandon abandon", PASSWORD),
        Err(CoreError::Wallet(WalletError::InvalidMnemonic(_)))
    ));
    let st = h.wallet.status();
    assert!(!st.has_vault && !st.unlocked);
}

#[test]
fn empty_password_is_refused() {
    let mut h = Harness::new(Network::BtcRegtest);
    assert_eq!(
        h.wallet.import(PHRASE, ""),
        Err(CoreError::Vault(VaultError::EmptyPassword))
    );
    assert!(!h.wallet.status().has_vault);
}

#[test]
fn entropy_failure_creates_nothing() {
    let node = MockNode::new("regtest");
    let mut w = Wallet::new(
        config(Network::BtcRegtest),
        node,
        tl_desktop_core::InMemoryStore::new(),
        TestClock::new(0),
        FailingEntropy,
    );
    assert_eq!(w.create(PASSWORD), Err(CoreError::Entropy));
    assert!(!w.status().has_vault);
}

#[test]
fn unlock_when_already_unlocked_keeps_pending_plans() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[100_000]);
    let p = h
        .wallet
        .prepare_send(&h.other_address(), 10_000, Some(2))
        .unwrap();
    assert_eq!(h.wallet.unlock("wrong"), Err(CoreError::WrongPassword));
    h.wallet.unlock(PASSWORD).unwrap();
    assert!(h.wallet.confirm_send(&p.plan_id).is_ok());
}

#[test]
fn dogecoin_is_unsupported() {
    let mut h = Harness::new(Network::Doge);
    assert_eq!(
        h.wallet.create(PASSWORD),
        Err(CoreError::UnsupportedNetwork(Network::Doge))
    );
    let st = h.wallet.status();
    assert!(!st.chain_matches && !st.has_vault);
}

// ------------------------------------------------------------------ locked wallet

#[test]
fn locked_wallet_refuses_everything_without_touching_the_node() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[100_000]);
    let to = h.other_address();
    let p = h.wallet.prepare_send(&to, 10_000, Some(2)).unwrap();
    h.wallet.lock();
    let (chains, scans) = {
        let s = h.node.state();
        (s.chain_calls, s.scan_calls)
    };
    assert_eq!(h.wallet.balance(), Err(CoreError::Locked));
    assert_eq!(
        h.wallet.prepare_send(&to, 10_000, Some(2)),
        Err(CoreError::Locked)
    );
    assert_eq!(h.wallet.confirm_send(&p.plan_id), Err(CoreError::Locked));
    let s = h.node.state();
    assert_eq!((s.chain_calls, s.scan_calls), (chains, scans));
    assert_eq!(s.broadcast_attempts, 0);
}

#[test]
fn lock_clears_every_pending_plan() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[100_000, 100_000, 100_000]);
    let to = h.other_address();
    let ids: Vec<String> = (0..3)
        .map(|_| h.wallet.prepare_send(&to, 10_000, Some(2)).unwrap().plan_id)
        .collect();
    assert_eq!(h.wallet.pending_plans(), 3);
    h.wallet.lock();
    assert_eq!(h.wallet.pending_plans(), 0);
    h.wallet.unlock(PASSWORD).unwrap();
    for id in &ids {
        assert_eq!(h.wallet.confirm_send(id), Err(CoreError::UnknownPlan));
        assert!(!h.wallet.cancel_send(id));
    }
    assert_eq!(h.node.state().broadcast_attempts, 0);
}

// ------------------------------------------------------------------ chain binding

#[test]
fn expected_chain_table() {
    assert_eq!(expected_chains(Network::BtcRegtest), Some(&["regtest"][..]));
    assert_eq!(expected_chains(Network::LtcRegtest), Some(&["regtest"][..]));
    assert_eq!(
        expected_chains(Network::BtcTest),
        Some(&["test", "testnet4"][..])
    );
    assert_eq!(expected_chains(Network::LtcTest), Some(&["test"][..]));
    assert_eq!(expected_chains(Network::Btc), Some(&["main"][..]));
    assert_eq!(expected_chains(Network::Ltc), Some(&["main"][..]));
    assert_eq!(expected_chains(Network::Doge), None);
}

#[test]
fn status_reports_chain_match_for_every_network() {
    let cases: &[(Network, &str, bool)] = &[
        (Network::BtcRegtest, "regtest", true),
        (Network::BtcRegtest, "test", false),
        (Network::BtcRegtest, "main", false),
        (Network::LtcRegtest, "regtest", true),
        (Network::LtcRegtest, "main", false),
        (Network::BtcTest, "test", true),
        (Network::BtcTest, "testnet4", true),
        (Network::BtcTest, "regtest", false),
        (Network::BtcTest, "main", false),
        (Network::LtcTest, "test", true),
        (Network::LtcTest, "testnet4", false),
        (Network::Btc, "main", true),
        (Network::Btc, "test", false),
        (Network::Btc, "regtest", false),
        (Network::Ltc, "main", true),
        (Network::Ltc, "regtest", false),
        (Network::Ltc, "", false),
    ];
    for (net, chain, want) in cases {
        let mut h = Harness::new(*net);
        h.node.state().chain = chain.to_string();
        let st = h.wallet.status();
        assert_eq!(st.chain_matches, *want, "{net:?} on {chain:?}");
        assert_eq!(st.node_chain.as_deref(), Some(*chain));
    }
}

#[test]
fn status_survives_a_dead_node() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.node.state().chain_error = true;
    let st = h.wallet.status();
    assert_eq!(st.node_chain, None);
    assert!(!st.chain_matches && st.unlocked && st.has_vault);
}

#[test]
fn chain_mismatch_blocks_scan_prepare_and_balance() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[100_000]);
    h.node.state().chain = "main".into();
    let to = h.other_address();
    let err = |actual: &str| CoreError::WrongChain {
        expected: &["regtest"],
        actual: actual.into(),
    };
    assert_eq!(h.wallet.balance(), Err(err("main")));
    assert_eq!(
        h.wallet.prepare_send(&to, 10_000, Some(2)),
        Err(err("main"))
    );
    let s = h.node.state();
    assert_eq!(s.scan_calls, 0);
    assert!(s.fee_calls.is_empty());
    assert_eq!(s.broadcast_attempts, 0);
}

#[test]
fn chain_flip_between_prepare_and_confirm_blocks_the_broadcast_and_consumes_the_plan() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[100_000]);
    let p = h
        .wallet
        .prepare_send(&h.other_address(), 10_000, Some(2))
        .unwrap();
    h.node.state().chain = "main".into();
    assert!(matches!(
        h.wallet.confirm_send(&p.plan_id),
        Err(CoreError::WrongChain { .. })
    ));
    h.node.state().chain = "regtest".into();
    assert_eq!(
        h.wallet.confirm_send(&p.plan_id),
        Err(CoreError::UnknownPlan)
    );
    assert_eq!(h.node.state().broadcast_attempts, 0);
}

#[test]
fn a_dead_node_blocks_with_a_node_error() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.node.state().chain_error = true;
    assert!(matches!(
        h.wallet.balance(),
        Err(CoreError::Node(NodeError::Transport(_)))
    ));
}

#[test]
fn the_network_is_never_inferred_from_the_address() {
    // A litecoin-regtest address handed to a bitcoin-regtest wallet is refused before any scan.
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[100_000]);
    let ltc = Harness::new(Network::LtcRegtest).other_address();
    assert!(ltc.starts_with("rltc1"));
    assert!(matches!(
        h.wallet.prepare_send(&ltc, 10_000, Some(2)),
        Err(CoreError::Wallet(WalletError::InvalidAddress(_)))
    ));
    let long = "b".repeat(10_000);
    for bad in ["", "bcrt1garbage", "not an address", long.as_str()] {
        assert!(matches!(
            h.wallet.prepare_send(bad, 10_000, Some(2)),
            Err(CoreError::Wallet(_))
        ));
    }
    assert_eq!(h.node.state().scan_calls, 0);
}

// ------------------------------------------------------------------ scan and balance

#[test]
fn balance_sums_the_scan() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    assert_eq!(h.balance().utxo_count, 0);
    assert_eq!(h.balance().confirmed_sats, 0);
    h.fund(&[100_000, 250_000, 7]);
    let change_hex = h.change_script_hex();
    let u = h.utxo(change_hex, 5_000);
    h.node.state().utxos.push(u);
    h.node.state().height = 321;
    let b = h.balance();
    assert_eq!(b.confirmed_sats, 355_007);
    assert_eq!(b.unconfirmed_sats, 0);
    assert_eq!(b.utxo_count, 4);
    assert_eq!(b.height, 321);
}

#[test]
fn scan_asks_for_the_receive_and_change_addresses() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.balance();
    let recv = h.wallet.receive_address().unwrap();
    let d = h.node.state().descriptors.last().cloned().unwrap();
    assert_eq!(d.len(), 2);
    assert_eq!(d[0], format!("addr({recv})"));
    assert!(d[1].starts_with("addr(bcrt1") && d[1] != d[0]);
}

#[test]
fn a_foreign_script_rejects_the_whole_scan() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[100_000]);
    let other = h.other_script().to_hex_string();
    let foreign = h.utxo(other, 9_999);
    let txid = foreign.txid.clone();
    h.node.state().utxos.push(foreign);
    assert_eq!(
        h.wallet.balance(),
        Err(CoreError::ForeignUtxo {
            txid: txid.clone(),
            vout: 0
        })
    );
    assert_eq!(
        h.wallet.prepare_send(&h.other_address(), 10_000, Some(2)),
        Err(CoreError::ForeignUtxo { txid, vout: 0 })
    );
    assert_eq!(h.wallet.pending_plans(), 0);
}

#[test]
fn malformed_scan_entries_are_typed_errors() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    let hex = h.receive_script_hex();

    let mut bad_txid = h.utxo(hex.clone(), 1_000);
    bad_txid.txid = "zz".into();
    let mut short_txid = h.utxo(hex.clone(), 1_000);
    short_txid.txid = "ab".repeat(16);
    let mut bad_hex = h.utxo("00zz".into(), 1_000);
    bad_hex.vout = 1;
    let zero = h.utxo(hex.clone(), 0);
    let huge = h.utxo(hex.clone(), u64::MAX);
    for u in [bad_txid, short_txid, bad_hex, zero, huge] {
        h.node.state().utxos = vec![u];
        assert!(
            matches!(h.wallet.balance(), Err(CoreError::InvalidScan(_))),
            "{:?}",
            h.node.state().utxos
        );
    }

    let a = h.utxo(hex.clone(), 1_000);
    let mut dup = a.clone();
    dup.amount_sats = 2_000;
    h.node.state().utxos = vec![a, dup];
    assert_eq!(
        h.wallet.balance(),
        Err(CoreError::InvalidScan("duplicate outpoint"))
    );

    let many: Vec<_> = (0..2_001).map(|_| h.utxo(hex.clone(), 1_000)).collect();
    h.node.state().utxos = many;
    assert_eq!(
        h.wallet.balance(),
        Err(CoreError::InvalidScan("too many utxos"))
    );
}

#[test]
fn balance_sums_the_largest_amounts_exactly() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    // Per-entry amounts are capped, so the checked sum of at most 2000 entries cannot wrap.
    let max = 84_000_000u64 * 100_000_000;
    h.fund(&[max, max]);
    assert_eq!(h.balance().confirmed_sats, 2 * max);
}

// ------------------------------------------------------------------ prepare and confirm

#[test]
fn prepare_then_confirm_broadcasts_exactly_the_previewed_transaction() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[1_000_000]);
    let to = h.other_address();
    let p = h.wallet.prepare_send(&to, 250_000, Some(5)).unwrap();

    // 5 sat/vB * (85 fixed + 68 per input) with one input
    assert_eq!(p.fee_sats, 765);
    assert_eq!(p.change_sats, 1_000_000 - 250_000 - 765);
    assert_eq!(p.input_count, 1);
    assert_eq!(p.fee_rate_sat_vb, 5);
    assert_eq!(p.amount_sats, 250_000);
    assert_eq!(p.to, to);
    assert_eq!(p.expires_at_ms, 1_000_000 + 120_000);
    assert_eq!(p.plan_id.len(), 32);
    assert!(p
        .plan_id
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    assert_eq!(
        h.node.state().broadcast_attempts,
        0,
        "prepare never broadcasts"
    );

    let sent = h.wallet.confirm_send(&p.plan_id).unwrap();
    let s = h.node.state();
    assert_eq!(s.broadcasts.len(), 1);
    let tx = decode(&s.broadcasts[0]);
    assert_eq!(sent.txid, tx.compute_txid().to_string());

    // outputs equal the preview: recipient, then change to the wallet's own change script
    assert_eq!(tx.output.len(), 2);
    let recipient = tl_wallet_core::Address::parse(Network::BtcRegtest, &to).unwrap();
    assert_eq!(
        tx.output[0].script_pubkey.as_script(),
        recipient.script_pubkey()
    );
    assert_eq!(tx.output[0].value.to_sat(), p.amount_sats);
    assert_eq!(tx.output[1].value.to_sat(), p.change_sats);
    drop(s);
    assert_eq!(tx.output[1].script_pubkey, h.change_script());

    // conservation: inputs = recipient + change + fee
    let spent: u64 = tx
        .input
        .iter()
        .map(|i| {
            let s = h.node.state();
            s.utxos
                .iter()
                .find(|u| {
                    u.txid == i.previous_output.txid.to_string() && u.vout == i.previous_output.vout
                })
                .expect("input is a scanned utxo")
                .amount_sats
        })
        .sum();
    let out: u64 = tx.output.iter().map(|o| o.value.to_sat()).sum();
    assert_eq!(spent, out + p.fee_sats);

    // signed and final
    assert!(tx.input.iter().all(|i| i.witness.len() == 2));
}

#[test]
fn confirm_twice_broadcasts_once() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[1_000_000]);
    let p = h
        .wallet
        .prepare_send(&h.other_address(), 100_000, Some(2))
        .unwrap();
    assert!(h.wallet.confirm_send(&p.plan_id).is_ok());
    assert_eq!(
        h.wallet.confirm_send(&p.plan_id),
        Err(CoreError::UnknownPlan)
    );
    assert_eq!(h.node.state().broadcasts.len(), 1);
    assert_eq!(h.node.state().broadcast_attempts, 1);
}

#[test]
fn unknown_and_malformed_plan_ids_are_refused() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[1_000_000]);
    let p = h
        .wallet
        .prepare_send(&h.other_address(), 100_000, Some(2))
        .unwrap();
    let bad_ids = [
        String::new(),
        "zz".to_string(),
        p.plan_id.to_uppercase(),
        p.plan_id[..31].to_string(),
        "f".repeat(1_000_000),
    ];
    for id in &bad_ids {
        assert_eq!(h.wallet.confirm_send(id), Err(CoreError::UnknownPlan));
        assert!(!h.wallet.cancel_send(id));
    }
    assert_eq!(h.wallet.pending_plans(), 1);
    assert_eq!(h.node.state().broadcast_attempts, 0);
}

#[test]
fn plan_ids_are_distinct() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[100_000, 100_000, 100_000]);
    let to = h.other_address();
    let ids: std::collections::BTreeSet<String> = (0..3)
        .map(|_| h.wallet.prepare_send(&to, 1_000, Some(2)).unwrap().plan_id)
        .collect();
    assert_eq!(ids.len(), 3);
}

#[test]
fn an_expired_plan_is_refused_and_consumed() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[1_000_000]);
    let p = h
        .wallet
        .prepare_send(&h.other_address(), 100_000, Some(2))
        .unwrap();
    h.clock.set(p.expires_at_ms);
    assert_eq!(
        h.wallet.confirm_send(&p.plan_id),
        Err(CoreError::PlanExpired)
    );
    h.clock.set(p.expires_at_ms - 1);
    assert_eq!(
        h.wallet.confirm_send(&p.plan_id),
        Err(CoreError::UnknownPlan)
    );
    assert_eq!(h.node.state().broadcast_attempts, 0);
}

#[test]
fn a_plan_one_millisecond_before_expiry_is_confirmable() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[1_000_000]);
    let p = h
        .wallet
        .prepare_send(&h.other_address(), 100_000, Some(2))
        .unwrap();
    h.clock.set(p.expires_at_ms - 1);
    assert!(h.wallet.confirm_send(&p.plan_id).is_ok());
}

#[test]
fn the_plan_table_is_bounded_at_eight() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[100_000; 10]);
    let to = h.other_address();
    let mut ids = Vec::new();
    for _ in 0..8 {
        ids.push(h.wallet.prepare_send(&to, 10_000, Some(2)).unwrap().plan_id);
    }
    assert_eq!(h.wallet.pending_plans(), 8);
    assert_eq!(
        h.wallet.prepare_send(&to, 10_000, Some(2)),
        Err(CoreError::TooManyPending)
    );
    assert_eq!(h.wallet.pending_plans(), 8);

    // cancelling frees a slot (and the plan's input)
    assert!(h.wallet.cancel_send(&ids[3]));
    assert!(!h.wallet.cancel_send(&ids[3]));
    assert!(h.wallet.prepare_send(&to, 10_000, Some(2)).is_ok());
    assert_eq!(
        h.wallet.prepare_send(&to, 10_000, Some(2)),
        Err(CoreError::TooManyPending)
    );

    // expiry frees every slot
    h.clock.advance(120_000);
    h.wallet.tick();
    assert_eq!(h.wallet.pending_plans(), 0);
    assert!(h.wallet.prepare_send(&to, 10_000, Some(2)).is_ok());
    assert_eq!(h.wallet.pending_plans(), 1);
}

#[test]
fn expired_plans_do_not_hold_the_table_full() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[100_000; 10]);
    let to = h.other_address();
    for _ in 0..8 {
        h.wallet.prepare_send(&to, 10_000, Some(2)).unwrap();
    }
    h.clock.advance(120_000);
    assert!(h.wallet.prepare_send(&to, 10_000, Some(2)).is_ok());
    assert_eq!(h.wallet.pending_plans(), 1);
}

#[test]
fn pending_plans_reserve_their_inputs() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[100_000]);
    let to = h.other_address();
    let p = h.wallet.prepare_send(&to, 10_000, Some(2)).unwrap();
    assert!(matches!(
        h.wallet.prepare_send(&to, 10_000, Some(2)),
        Err(CoreError::Wallet(WalletError::InsufficientFunds { .. }))
    ));
    assert!(h.wallet.cancel_send(&p.plan_id));
    assert!(h.wallet.prepare_send(&to, 10_000, Some(2)).is_ok());
}

#[test]
fn broadcast_inputs_stay_hidden_until_the_node_drops_them() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[100_000]);
    let to = h.other_address();
    let p = h.wallet.prepare_send(&to, 10_000, Some(2)).unwrap();
    h.wallet.confirm_send(&p.plan_id).unwrap();
    // The scan does not see the mempool: the spent output is still listed.
    assert_eq!(h.balance().utxo_count, 1);
    assert!(matches!(
        h.wallet.prepare_send(&to, 10_000, Some(2)),
        Err(CoreError::Wallet(WalletError::InsufficientFunds { .. }))
    ));
    // Once mined, the scan lists only new outputs and spending works again.
    h.node.state().utxos.clear();
    h.fund(&[300_000]);
    assert!(h.wallet.prepare_send(&to, 10_000, Some(2)).is_ok());
}

#[test]
fn a_failed_broadcast_consumes_the_plan_and_surfaces_the_node_error() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[1_000_000]);
    let to = h.other_address();
    let p = h.wallet.prepare_send(&to, 100_000, Some(2)).unwrap();
    let rejection = NodeError::Rpc {
        code: -26,
        message: "txn-mempool-conflict".into(),
    };
    h.node.state().broadcast_error = Some(rejection.clone());
    assert_eq!(
        h.wallet.confirm_send(&p.plan_id),
        Err(CoreError::Node(rejection))
    );
    assert_eq!(h.node.state().broadcast_attempts, 1);
    assert!(h.node.state().broadcasts.is_empty());
    assert_eq!(h.wallet.pending_plans(), 0);
    // no second attempt with the same id, even after the node recovers
    h.node.state().broadcast_error = None;
    assert_eq!(
        h.wallet.confirm_send(&p.plan_id),
        Err(CoreError::UnknownPlan)
    );
    assert_eq!(h.node.state().broadcast_attempts, 1);
    // a failed broadcast does not mark inputs as spent: a fresh plan can use them
    assert!(h.wallet.prepare_send(&to, 100_000, Some(2)).is_ok());
}

#[test]
fn a_node_reporting_another_txid_is_an_error_after_the_broadcast() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[1_000_000]);
    let p = h
        .wallet
        .prepare_send(&h.other_address(), 100_000, Some(2))
        .unwrap();
    h.node.state().reply_txid = Some("00".repeat(32));
    let err = h.wallet.confirm_send(&p.plan_id).unwrap_err();
    assert!(
        matches!(err, CoreError::BroadcastTxidMismatch { .. }),
        "{err:?}"
    );
    assert_eq!(h.node.state().broadcasts.len(), 1);
}

#[test]
fn insufficient_funds_and_dust_are_typed() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    let to = h.other_address();
    assert!(matches!(
        h.wallet.prepare_send(&to, 5_000, Some(2)),
        Err(CoreError::Wallet(WalletError::InsufficientFunds { .. }))
    ));
    h.fund(&[1_000]);
    assert!(matches!(
        h.wallet.prepare_send(&to, 5_000, Some(2)),
        Err(CoreError::Wallet(WalletError::InsufficientFunds { .. }))
    ));
    h.fund(&[1_000_000]);
    assert!(matches!(
        h.wallet.prepare_send(&to, 1, Some(2)),
        Err(CoreError::Wallet(WalletError::DustOutput { .. }))
    ));
    assert!(matches!(
        h.wallet.prepare_send(&to, 0, Some(2)),
        Err(CoreError::Wallet(_))
    ));
    assert!(matches!(
        h.wallet.prepare_send(&to, u64::MAX, Some(2)),
        Err(CoreError::Wallet(_))
    ));
    assert_eq!(h.wallet.pending_plans(), 0);
}

// ------------------------------------------------------------------ fee rate

#[test]
fn explicit_fee_rate_is_bounded() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[10_000_000, 10_000_000, 10_000_000]);
    let to = h.other_address();
    assert_eq!(
        h.wallet.prepare_send(&to, 100_000, Some(0)),
        Err(CoreError::InvalidFeeRate {
            rate: 0,
            max: 1_000
        })
    );
    assert_eq!(
        h.wallet.prepare_send(&to, 100_000, Some(1_001)),
        Err(CoreError::InvalidFeeRate {
            rate: 1_001,
            max: 1_000
        })
    );
    assert_eq!(
        h.wallet.prepare_send(&to, 100_000, Some(u64::MAX)),
        Err(CoreError::InvalidFeeRate {
            rate: u64::MAX,
            max: 1_000
        })
    );
    let ok = h.wallet.prepare_send(&to, 100_000, Some(1_000)).unwrap();
    assert_eq!(ok.fee_sats, 1_000 * (85 + 68));
    let low = h.wallet.prepare_send(&to, 100_000, Some(1)).unwrap();
    assert_eq!(low.fee_sats, 85 + 68);
    assert_eq!(h.wallet.pending_plans(), 2);
}

#[test]
fn rate_bound_is_configurable() {
    let mut cfg = config(Network::BtcRegtest);
    cfg.max_fee_rate_sat_vb = 10;
    let mut h = Harness::with_config(cfg);
    h.wallet.import(PHRASE, PASSWORD).unwrap();
    h.fund(&[1_000_000]);
    assert_eq!(
        h.wallet.prepare_send(&h.other_address(), 100_000, Some(11)),
        Err(CoreError::InvalidFeeRate { rate: 11, max: 10 })
    );
}

#[test]
fn absolute_fee_bound_applies() {
    let mut cfg = config(Network::BtcRegtest);
    cfg.max_fee_sats = 500;
    let mut h = Harness::with_config(cfg);
    h.wallet.import(PHRASE, PASSWORD).unwrap();
    h.fund(&[1_000_000]);
    assert_eq!(
        h.wallet.prepare_send(&h.other_address(), 100_000, Some(5)),
        Err(CoreError::FeeAboveMax { fee: 765, max: 500 })
    );
    assert!(h
        .wallet
        .prepare_send(&h.other_address(), 100_000, Some(3))
        .is_ok());
}

#[test]
fn fee_rate_defaults_to_the_node_estimate_with_target_six() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[1_000_000]);
    h.node.state().fee_estimate = Some(7);
    let p = h
        .wallet
        .prepare_send(&h.other_address(), 100_000, None)
        .unwrap();
    assert_eq!(p.fee_rate_sat_vb, 7);
    assert_eq!(p.fee_sats, 7 * 153);
    assert_eq!(h.node.state().fee_calls, vec![6]);
}

#[test]
fn an_explicit_rate_skips_the_node_estimate() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[1_000_000]);
    h.node.state().fee_estimate = Some(7);
    let p = h
        .wallet
        .prepare_send(&h.other_address(), 100_000, Some(3))
        .unwrap();
    assert_eq!(p.fee_rate_sat_vb, 3);
    assert!(h.node.state().fee_calls.is_empty());
}

#[test]
fn regtest_without_an_estimate_uses_the_config_default() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[1_000_000]);
    let p = h
        .wallet
        .prepare_send(&h.other_address(), 100_000, None)
        .unwrap();
    assert_eq!(p.fee_rate_sat_vb, 2);
}

#[test]
fn a_node_estimate_above_the_bound_is_refused() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    h.fund(&[1_000_000]);
    h.node.state().fee_estimate = Some(50_000);
    assert_eq!(
        h.wallet.prepare_send(&h.other_address(), 100_000, None),
        Err(CoreError::InvalidFeeRate {
            rate: 50_000,
            max: 1_000
        })
    );
    h.node.state().fee_estimate = Some(0);
    assert!(matches!(
        h.wallet.prepare_send(&h.other_address(), 100_000, None),
        Err(CoreError::InvalidFeeRate { rate: 0, .. })
    ));
}

#[test]
fn a_public_network_without_an_estimate_needs_an_explicit_rate() {
    let mut h = Harness::unlocked(Network::BtcTest);
    h.fund(&[1_000_000]);
    let to = h.other_address();
    assert_eq!(
        h.wallet.prepare_send(&to, 100_000, None),
        Err(CoreError::NoFeeEstimate)
    );
    assert!(h.wallet.prepare_send(&to, 100_000, Some(4)).is_ok());
}

// ------------------------------------------------------------------ other networks

#[test]
fn litecoin_regtest_round_trip() {
    let mut h = Harness::unlocked(Network::LtcRegtest);
    assert!(h.wallet.receive_address().unwrap().starts_with("rltc1"));
    h.fund(&[5_000_000]);
    let p = h
        .wallet
        .prepare_send(&h.other_address(), 1_000_000, Some(3))
        .unwrap();
    let sent = h.wallet.confirm_send(&p.plan_id).unwrap();
    assert_eq!(sent.txid.len(), 64);
}

#[test]
fn testnet4_node_serves_a_bitcoin_testnet_wallet() {
    let mut h = Harness::unlocked(Network::BtcTest);
    h.node.state().chain = "testnet4".into();
    h.fund(&[1_000_000]);
    let p = h
        .wallet
        .prepare_send(&h.other_address(), 100_000, Some(2))
        .unwrap();
    assert!(h.wallet.confirm_send(&p.plan_id).is_ok());
}

#[test]
fn the_desktop_origin_is_a_valid_http_origin() {
    assert!(tl_wallet_core::Origin::from_url(DESKTOP_ORIGIN).is_ok());
    assert_eq!(DESKTOP_ORIGIN, "http://tauri.localhost");
}

// ------------------------------------------------------------------ coinbase maturity

#[test]
fn immature_coinbase_is_reported_but_never_spendable() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    let recv = h.receive_script_hex();
    h.node.state().height = 200;
    // 101 confirmations: tip 200, mined at 100 -> mature. 100 confirmations at 101: mature.
    // 99 confirmations at 102: immature.
    let mut mature = h.utxo(recv.clone(), 5_000_000_000);
    mature.coinbase = true;
    mature.height = 101;
    let mut immature = h.utxo(recv.clone(), 5_000_000_000);
    immature.coinbase = true;
    immature.height = 102;
    let fresh = h.utxo(recv, 1_000);
    h.node.state().utxos.extend([mature, immature, fresh]);
    let b = h.balance();
    assert_eq!(b.confirmed_sats, 5_000_001_000);
    assert_eq!(b.immature_sats, 5_000_000_000);
    assert_eq!(b.utxo_count, 2);
    // Asking for more than the spendable total fails even though the immature coin would cover it.
    let to = h.other_address();
    assert!(h.wallet.prepare_send(&to, 6_000_000_000, Some(2)).is_err());
    let pv = h.wallet.prepare_send(&to, 4_000_000_000, Some(2)).unwrap();
    assert_eq!(pv.input_count, 1);
}

#[test]
fn utxo_above_the_scan_tip_rejects_the_scan() {
    let mut h = Harness::unlocked(Network::BtcRegtest);
    let recv = h.receive_script_hex();
    let mut u = h.utxo(recv, 10_000);
    u.height = 201;
    h.node.state().utxos.push(u);
    assert_eq!(
        h.wallet.balance().unwrap_err(),
        CoreError::InvalidScan("utxo above tip")
    );
}
