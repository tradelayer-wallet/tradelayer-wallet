#![allow(dead_code)]
use tl_wallet_service::amount::Amount;
use tl_wallet_service::txbuilder::Utxo;

pub const G: &str = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
pub const G2: &str = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
pub const G3: &str = "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

pub fn sat(n: u64) -> Amount {
    Amount::from_sat(n).unwrap()
}

pub fn txid(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}

pub fn utxo(n: u8, vout: u32, amount: u64) -> Utxo {
    Utxo {
        txid: txid(n),
        vout,
        amount: sat(amount),
        confirmations: 3,
        script_pub_key: "0014".to_string() + &"11".repeat(20),
        redeem_script: None,
        pubkey: Some(G.to_string()),
    }
}
