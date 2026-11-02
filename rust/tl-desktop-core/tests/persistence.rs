//! The wallet over `FileStore`: the vault survives a restart and nothing else is written.

mod common;

use common::*;
use std::path::PathBuf;
use tl_desktop_core::{CoreError, FileStore, Wallet};
use tl_wallet_core::Network;

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let p =
            std::env::temp_dir().join(format!("tl-desktop-core-it-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        TempDir(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn wallet_over(
    dir: &TempDir,
    entropy_seed: u64,
) -> Wallet<MockNode, FileStore, TestClock, SeqEntropy> {
    Wallet::new(
        config(Network::BtcRegtest),
        MockNode::new("regtest"),
        FileStore::open(&dir.0).unwrap(),
        TestClock::new(5),
        SeqEntropy(entropy_seed),
    )
}

#[test]
fn the_vault_survives_a_restart() {
    let dir = TempDir::new("restart");
    let (phrase, addr) = {
        let mut w = wallet_over(&dir, 1);
        let phrase = w.create(PASSWORD).unwrap();
        (phrase, w.receive_address().unwrap())
    };

    let mut w = wallet_over(&dir, 2);
    let st = w.status();
    assert!(st.has_vault && !st.unlocked);
    assert_eq!(w.unlock("nope"), Err(CoreError::WrongPassword));
    w.unlock(PASSWORD).unwrap();
    assert_eq!(w.receive_address().unwrap(), addr);

    // the same phrase imported elsewhere derives the same address
    let other = TempDir::new("restart-other");
    let mut w2 = wallet_over(&other, 3);
    w2.import(&phrase, "second password").unwrap();
    assert_eq!(w2.receive_address().unwrap(), addr);
}

#[test]
fn a_second_create_over_the_same_directory_is_refused() {
    let dir = TempDir::new("twice");
    let mut w = wallet_over(&dir, 1);
    w.create(PASSWORD).unwrap();
    let mut again = wallet_over(&dir, 2);
    assert_eq!(again.create("other"), Err(CoreError::VaultExists));
    assert_eq!(again.import(PHRASE, "other"), Err(CoreError::VaultExists));
    again.unlock(PASSWORD).unwrap();
}

#[test]
fn only_vault_files_are_written_and_the_phrase_is_not_among_them() {
    let dir = TempDir::new("files");
    let mut w = wallet_over(&dir, 1);
    w.import(PHRASE, PASSWORD).unwrap();
    let mut names = Vec::new();
    for e in std::fs::read_dir(&dir.0).unwrap() {
        let e = e.unwrap();
        let body = std::fs::read(e.path()).unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(!text.contains("abandon"), "plaintext phrase on disk");
        assert!(!text.contains(PASSWORD));
        names.push(e.file_name().into_string().unwrap());
    }
    names.sort();
    assert_eq!(names, vec!["vault.record.val", "vault.v1.val"]);
}

#[test]
fn a_tampered_vault_file_is_a_wrong_password_not_garbage() {
    let dir = TempDir::new("tamper");
    {
        let mut w = wallet_over(&dir, 1);
        w.import(PHRASE, PASSWORD).unwrap();
    }
    let path = dir.0.join("vault.v1.val");
    let mut text = std::fs::read_to_string(&path).unwrap();
    let last = text.pop().unwrap();
    text.push(if last == 'A' { 'B' } else { 'A' });
    std::fs::write(&path, text).unwrap();
    let mut w = wallet_over(&dir, 2);
    assert!(w.unlock(PASSWORD).is_err());
    assert!(!w.status().unlocked);
}
