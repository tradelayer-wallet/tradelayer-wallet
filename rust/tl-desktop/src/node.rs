//! `NodeRpc` over `tl-rpc-client`: four calls, no retries, no other methods.

use serde_json::Value;
use tl_desktop_core::{NodeError, NodeRpc, ScanResult, ScannedUtxo};
use tl_rpc_client::http::{Credentials, HttpTransport};
use tl_rpc_client::{Client, Error as RpcError, Limits, NodeCall, ReadCall};

const SATS_PER_COIN: f64 = 100_000_000.0;
/// Bound on UTXOs accepted from one scan (the core applies its own bound as well).
const MAX_SCAN_UTXOS: usize = 10_000;

pub struct RpcNode {
    client: Client<HttpTransport>,
}

impl RpcNode {
    pub fn connect(url: &str, user: &str, password: &str) -> Result<Self, NodeError> {
        let creds = Credentials::new(user, password)
            .map_err(|_| NodeError::Transport("invalid RPC credentials".into()))?;
        let transport =
            HttpTransport::new(url, creds, None).map_err(|e| NodeError::Transport(describe(&e)))?;
        // scantxoutset walks the whole UTXO set: allow it a minute and a 8 MiB answer.
        let limits = Limits::new(std::time::Duration::from_secs(60), 8 * 1024 * 1024)
            .map_err(|e| NodeError::Transport(describe(&e)))?;
        Ok(RpcNode {
            client: Client::new(transport, limits),
        })
    }
}

fn describe(e: &RpcError) -> String {
    format!("{e:?}")
}

fn map_err(e: RpcError) -> NodeError {
    match e {
        RpcError::Rpc { code, message } => NodeError::Rpc { code, message },
        RpcError::Malformed | RpcError::MissingId | RpcError::IdMismatch => {
            NodeError::Malformed(describe(&e))
        }
        other => NodeError::Transport(describe(&other)),
    }
}

/// Exact conversion of a JSON coin amount to satoshis. The node prints amounts with at most
/// eight decimals; serde_json hands us the nearest f64. The candidate satoshi value is accepted
/// only if it maps back to the same f64 and neither neighbour does, so a value is either exact
/// or rejected.
pub fn coins_to_sats(v: &Value) -> Result<u64, NodeError> {
    let x = v
        .as_f64()
        .ok_or_else(|| NodeError::Malformed("amount is not a number".into()))?;
    if !(0.0..=84_000_000.0).contains(&x) {
        return Err(NodeError::Malformed("amount out of range".into()));
    }
    let candidate = (x * SATS_PER_COIN).round();
    let back = |s: f64| s / SATS_PER_COIN;
    if back(candidate) != x
        || (candidate >= 1.0 && back(candidate - 1.0) == x)
        || back(candidate + 1.0) == x
    {
        return Err(NodeError::Malformed(
            "amount is not an exact satoshi value".into(),
        ));
    }
    Ok(candidate as u64)
}

fn field<'a>(v: &'a Value, key: &str) -> Result<&'a Value, NodeError> {
    v.get(key)
        .ok_or_else(|| NodeError::Malformed(format!("missing field {key}")))
}

fn as_u64(v: &Value, key: &str) -> Result<u64, NodeError> {
    field(v, key)?
        .as_u64()
        .ok_or_else(|| NodeError::Malformed(format!("field {key} is not an integer")))
}

fn as_str<'a>(v: &'a Value, key: &str) -> Result<&'a str, NodeError> {
    field(v, key)?
        .as_str()
        .ok_or_else(|| NodeError::Malformed(format!("field {key} is not a string")))
}

/// Parse a `scantxoutset start` result.
pub fn parse_scan(v: &Value) -> Result<ScanResult, NodeError> {
    if field(v, "success")?.as_bool() != Some(true) {
        return Err(NodeError::Malformed("scan did not succeed".into()));
    }
    let height = as_u64(v, "height")?;
    let unspents = field(v, "unspents")?
        .as_array()
        .ok_or_else(|| NodeError::Malformed("unspents is not an array".into()))?;
    if unspents.len() > MAX_SCAN_UTXOS {
        return Err(NodeError::Malformed("too many unspents".into()));
    }
    let mut utxos = Vec::with_capacity(unspents.len());
    for u in unspents {
        let vout = u32::try_from(as_u64(u, "vout")?)
            .map_err(|_| NodeError::Malformed("vout out of range".into()))?;
        utxos.push(ScannedUtxo {
            txid: as_str(u, "txid")?.to_string(),
            vout,
            script_pubkey_hex: as_str(u, "scriptPubKey")?.to_string(),
            amount_sats: coins_to_sats(field(u, "amount")?)?,
            height: as_u64(u, "height")?,
            coinbase: field(u, "coinbase")?
                .as_bool()
                .ok_or_else(|| NodeError::Malformed("coinbase is not a bool".into()))?,
        });
    }
    Ok(ScanResult { height, utxos })
}

/// `estimatesmartfee` gives coins per 1000 vB; round up to whole sat/vB, at least 1.
pub fn parse_fee_rate(v: &Value) -> Result<Option<u64>, NodeError> {
    match v.get("feerate") {
        None | Some(Value::Null) => Ok(None),
        Some(rate) => {
            let per_kvb = coins_to_sats(rate)?;
            Ok(Some(per_kvb.div_ceil(1000).max(1)))
        }
    }
}

impl NodeRpc for RpcNode {
    fn chain(&mut self) -> Result<String, NodeError> {
        let v = self
            .client
            .call(ReadCall::GetBlockchainInfo)
            .map_err(map_err)?;
        Ok(as_str(&v, "chain")?.to_string())
    }

    fn scan(&mut self, descriptors: &[String]) -> Result<ScanResult, NodeError> {
        let v = self
            .client
            .call_node(NodeCall::ScanTxOutSet(descriptors.to_vec()))
            .map_err(map_err)?;
        parse_scan(&v)
    }

    fn fee_rate_sat_per_vb(&mut self, conf_target: u16) -> Result<Option<u64>, NodeError> {
        let v = self
            .client
            .call_node(NodeCall::EstimateSmartFee(conf_target))
            .map_err(map_err)?;
        parse_fee_rate(&v)
    }

    fn broadcast(&mut self, raw_tx_hex: &str) -> Result<String, NodeError> {
        let v = self
            .client
            .call_node(NodeCall::SendRawTransaction(raw_tx_hex.to_string()))
            .map_err(map_err)?;
        v.as_str()
            .map(str::to_string)
            .ok_or_else(|| NodeError::Malformed("txid is not a string".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn amounts_convert_exactly() {
        assert_eq!(coins_to_sats(&json!(50.0)).unwrap(), 5_000_000_000);
        assert_eq!(coins_to_sats(&json!(0.00000001)).unwrap(), 1);
        assert_eq!(coins_to_sats(&json!(0.1)).unwrap(), 10_000_000);
        assert_eq!(
            coins_to_sats(&json!(20999999.9769)).unwrap(),
            2_099_999_997_690_000
        );
        assert_eq!(coins_to_sats(&json!(0)).unwrap(), 0);
    }

    #[test]
    fn non_satoshi_or_hostile_amounts_are_rejected() {
        assert!(coins_to_sats(&json!(0.000000001)).is_err());
        assert!(coins_to_sats(&json!(-1)).is_err());
        assert!(coins_to_sats(&json!("1.0")).is_err());
        assert!(coins_to_sats(&json!(1e300)).is_err());
    }

    #[test]
    fn scan_result_parses() {
        let v = json!({
            "success": true, "txouts": 10, "height": 205,
            "bestblock": "00", "unspents": [
                {"txid": "aa".repeat(32), "vout": 1, "scriptPubKey": "0014", "desc": "addr(x)",
                 "amount": 1.5, "coinbase": false, "height": 204, "blockhash": "00"}
            ], "total_amount": 1.5
        });
        let s = parse_scan(&v).unwrap();
        assert_eq!(s.height, 205);
        assert_eq!(s.utxos[0].amount_sats, 150_000_000);
        assert_eq!(s.utxos[0].vout, 1);
        assert!(!s.utxos[0].coinbase);
    }

    #[test]
    fn malformed_scans_are_rejected() {
        assert!(parse_scan(&json!({"success": false})).is_err());
        assert!(parse_scan(&json!({"success": true, "height": 1, "unspents": {}})).is_err());
        let missing_coinbase = json!({"success": true, "height": 1, "unspents": [
            {"txid": "aa", "vout": 0, "scriptPubKey": "00", "amount": 1, "height": 1}]});
        assert!(parse_scan(&missing_coinbase).is_err());
    }

    #[test]
    fn fee_rate_rounds_up_to_whole_sat_per_vbyte() {
        assert_eq!(
            parse_fee_rate(&json!({"feerate": 0.00001, "blocks": 6})).unwrap(),
            Some(1)
        );
        assert_eq!(
            parse_fee_rate(&json!({"feerate": 0.00012345})).unwrap(),
            Some(13)
        );
        assert_eq!(
            parse_fee_rate(&json!({"feerate": 0.000001})).unwrap(),
            Some(1)
        );
        assert_eq!(
            parse_fee_rate(&json!({"errors": ["Insufficient data"], "blocks": 0})).unwrap(),
            None
        );
    }
}
