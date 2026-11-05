//! `POST /api/compute-multisig` (FE-speed `computeMultisigNative`, `tx-builder.service.ts`): the
//! sorted m-of-n P2WSH channel address for a set of public keys.
//!
//! Public keys are put in BIP-67 order (byte-wise sort) before the script is built, so the same
//! key set always yields the same address whatever order the two parties list them in. The
//! network picks only the bech32 prefix: `ltc`, `tltc`, `bc`, `tb`. A node on a regtest chain accepts
//! only its own prefix (`bcrt` for Bitcoin Core, `rltc` for Litecoin Core), whichever network the UI
//! has selected, so the caller may pass that prefix and it replaces the label's. The `bitcoin` crate's
//! own address type has no Litecoin prefix, so the witness program is bech32-encoded directly.

use bitcoin::bech32::{segwit, Hrp};
use bitcoin::hex::{DisplayHex, FromHex};
use bitcoin::opcodes::all::OP_CHECKMULTISIG;
use bitcoin::script::Builder;
use bitcoin::{PublicKey, ScriptBuf};
use serde_json::{json, Value};

/// Most keys a standard `OP_CHECKMULTISIG` script can carry.
pub const MAX_KEYS: usize = 16;

fn hrp_for(network: &str) -> Option<&'static str> {
    match network {
        "LTC" => Some("ltc"),
        "LTCTEST" => Some("tltc"),
        "BTC" => Some("bc"),
        "BTCTEST" => Some("tb"),
        _ => None,
    }
}

/// The result object FE-speed sends under `data`: `{m, pubKeys, redeemScript, scriptPubKey,
/// address}` with the keys in canonical order. Error texts for the unknown-network and
/// key-count cases are FE-speed's; the rest are the port's own.
pub fn compute_multisig(
    m: Option<&Value>,
    pub_keys: Option<&Value>,
    network: &str,
) -> Result<Value, String> {
    compute_multisig_with_hrp(m, pub_keys, network, None)
}

/// [`compute_multisig`] with the bech32 prefix of the connected node's chain taking the place of the
/// network label's (`Some("bcrt")` or `Some("rltc")` on regtest). The label is still checked.
pub fn compute_multisig_with_hrp(
    m: Option<&Value>,
    pub_keys: Option<&Value>,
    network: &str,
    chain_hrp: Option<&str>,
) -> Result<Value, String> {
    let label_hrp = hrp_for(network).ok_or_else(|| format!("Unknown network: {network}"))?;
    let hrp = match chain_hrp {
        Some(h @ ("bcrt" | "rltc")) => h,
        Some(other) => return Err(format!("unsupported chain prefix: {other}")),
        None => label_hrp,
    };
    let keys = match pub_keys {
        Some(Value::Array(a)) => a,
        _ => return Err("Invalid pubKeys".into()),
    };
    let m_val = m.ok_or("Invalid m")?;
    let m_num = m_val
        .as_f64()
        .filter(|f| f.is_finite() && f.fract() == 0.0)
        .ok_or("Invalid m")?;
    if (keys.len() as f64) < m_num {
        return Err("Invalid pubKeys".into());
    }
    if m_num < 1.0 || keys.len() > MAX_KEYS {
        return Err("Invalid m or key count".into());
    }
    let m_int = m_num as i64;

    let mut bufs: Vec<[u8; 33]> = Vec::with_capacity(keys.len());
    for k in keys {
        let s = k.as_str().ok_or("Invalid pubKeys")?;
        let raw = Vec::<u8>::from_hex(s).map_err(|_| "pubkey is not hex".to_string())?;
        let arr: [u8; 33] = raw
            .as_slice()
            .try_into()
            .map_err(|_| "pubkey must be a 33-byte compressed public key".to_string())?;
        PublicKey::from_slice(&arr).map_err(|_| "pubkey is not a valid point".to_string())?;
        bufs.push(arr);
    }
    bufs.sort();

    let mut b = Builder::new().push_int(m_int);
    for k in &bufs {
        b = b.push_slice(k);
    }
    let redeem: ScriptBuf = b
        .push_int(bufs.len() as i64)
        .push_opcode(OP_CHECKMULTISIG)
        .into_script();
    let spk = ScriptBuf::new_p2wsh(&redeem.wscript_hash());
    let program = &spk.as_bytes()[2..];
    let address = segwit::encode_v0(
        Hrp::parse(hrp).map_err(|e| format!("bech32 prefix: {e}"))?,
        program,
    )
    .map_err(|e| format!("bech32 encode: {e}"))?;
    Ok(json!({
        "m": m_val,
        "pubKeys": bufs.iter().map(|k| k.to_lower_hex_string()).collect::<Vec<_>>(),
        "redeemScript": redeem.as_bytes().to_lower_hex_string(),
        "scriptPubKey": spk.as_bytes().to_lower_hex_string(),
        "address": address,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    const B: &str = "03f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

    #[test]
    fn regtest_prefix_replaces_the_label_prefix_and_keeps_the_script() {
        let keys = json!([A, B]);
        let label = compute_multisig(Some(&json!(2)), Some(&keys), "LTCTEST").unwrap();
        let on_bitcoin_regtest =
            compute_multisig_with_hrp(Some(&json!(2)), Some(&keys), "LTCTEST", Some("bcrt"))
                .unwrap();
        let on_litecoin_regtest =
            compute_multisig_with_hrp(Some(&json!(2)), Some(&keys), "BTC", Some("rltc")).unwrap();
        assert!(label["address"].as_str().unwrap().starts_with("tltc1q"));
        assert!(on_bitcoin_regtest["address"]
            .as_str()
            .unwrap()
            .starts_with("bcrt1q"));
        assert!(on_litecoin_regtest["address"]
            .as_str()
            .unwrap()
            .starts_with("rltc1q"));
        // same witness program, only the prefix differs
        assert_eq!(label["scriptPubKey"], on_bitcoin_regtest["scriptPubKey"]);
        assert_eq!(label["redeemScript"], on_litecoin_regtest["redeemScript"]);
        let strip =
            |v: &Value| v["address"].as_str().unwrap().split_once('1').unwrap().1[1..].to_string();
        assert_eq!(strip(&label).len(), strip(&on_bitcoin_regtest).len());
        assert!(
            compute_multisig_with_hrp(Some(&json!(2)), Some(&keys), "LTCTEST", Some("tb")).is_err()
        );
        assert!(
            compute_multisig_with_hrp(Some(&json!(2)), Some(&keys), "NOPE", Some("bcrt")).is_err()
        );
    }

    #[test]
    fn order_of_the_keys_does_not_matter() {
        let one = compute_multisig(Some(&json!(2)), Some(&json!([A, B])), "LTCTEST").unwrap();
        let two = compute_multisig(Some(&json!(2)), Some(&json!([B, A])), "LTCTEST").unwrap();
        assert_eq!(one, two);
        assert!(one["address"].as_str().unwrap().starts_with("tltc1q"));
    }

    #[test]
    fn bad_inputs_are_refused() {
        let k = Some(json!([A, B]));
        let c = |m: Value, keys: Option<&Value>, net: &str| compute_multisig(Some(&m), keys, net);
        assert_eq!(
            c(json!(2), k.as_ref(), "DOGE").unwrap_err(),
            "Unknown network: DOGE"
        );
        assert_eq!(
            c(json!(3), k.as_ref(), "LTC").unwrap_err(),
            "Invalid pubKeys"
        );
        assert_eq!(c(json!(2), None, "LTC").unwrap_err(), "Invalid pubKeys");
        assert!(c(json!(0), k.as_ref(), "LTC").is_err());
        assert!(c(json!(1.5), k.as_ref(), "LTC").is_err());
        assert!(c(json!("2"), k.as_ref(), "LTC").is_err());
        assert!(c(json!(1), Some(&json!(["zz", B])), "LTC").is_err());
        assert!(c(json!(1), Some(&json!([&A[..64], B])), "LTC").is_err());
        let bad_point = format!("02{}", "00".repeat(32));
        assert!(c(json!(1), Some(&json!([bad_point, B])), "LTC").is_err());
        let many: Vec<&str> = vec![A; 17];
        assert!(c(json!(1), Some(&json!(many)), "LTC").is_err());
    }
}
