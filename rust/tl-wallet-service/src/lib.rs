//! `tl-wallet-service`: Rust extraction of the TradeLayer desktop wallet's backend contracts and
//! non-UI trading logic. See README.md for the porting map and the compatibility table.

#![forbid(unsafe_code)]

pub mod amount;
pub mod bridge;
pub mod gate;
pub mod market;
pub mod mem;
pub mod nodecfg;
pub mod psbt;
pub mod service;
pub mod swap;
pub mod txbuilder;
