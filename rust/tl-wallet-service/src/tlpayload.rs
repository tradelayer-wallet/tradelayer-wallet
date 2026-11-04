//! Local TradeLayer payload encoders: the seven `tl_createpayload_*` methods FE-speed's
//! wallet-server answers without calling the TradeLayer listener
//! (`rpc-proxy.service.ts` `buildTradeLayerPayload`, commit 8da87d7 "Encode routed trade payloads
//! locally").
//!
//! The encoders read an untyped request body, so every conversion follows the JavaScript rules
//! ([`crate::jsval`]). `tests/fespeed_kat.rs` replays 23 fixed inputs whose expected strings came
//! from running FE-speed's own TypeScript (extracted unchanged and transpiled) under Node.

use crate::jsval::{
    base36_of_integer, encode_amount, encode_base36, encode_boolean, js_string, nullish, truthy,
};
use serde_json::Value;

/// A property read on the object the encoder works from. `null` has no properties (JavaScript
/// throws a `TypeError`); a number, string or array simply lacks the key.
struct Src<'a>(&'a Value);

impl<'a> Src<'a> {
    fn p(&self, key: &str) -> Result<Option<&'a Value>, String> {
        match self.0 {
            Value::Null => Err(format!("Cannot read properties of null (reading '{key}')")),
            Value::Object(m) => Ok(m.get(key)),
            _ => Ok(None),
        }
    }

    /// `a ?? b`
    fn first(&self, keys: &[&str]) -> Result<Option<&'a Value>, String> {
        for k in keys {
            let v = self.p(k)?;
            if !nullish(v) {
                return Ok(v);
            }
        }
        Ok(None)
    }

    /// `a || b || ''`, as a string.
    fn or_str(&self, keys: &[&str]) -> Result<String, String> {
        for k in keys {
            if let Some(v) = self.p(k)? {
                if truthy(v) {
                    return Ok(js_string(v));
                }
            }
        }
        Ok(String::new())
    }

    fn flag(&self, key: &str) -> Result<&'static str, String> {
        Ok(encode_boolean(self.p(key)?))
    }

    fn truthy_flag(&self, key: &str) -> Result<&'static str, String> {
        Ok(if self.p(key)?.is_some_and(truthy) {
            "1"
        } else {
            "0"
        })
    }
}

fn is_object_like(v: &Value) -> bool {
    matches!(v, Value::Null | Value::Array(_) | Value::Object(_))
}

/// Build the payload for `method`, or `Ok(None)` when FE-speed does not encode that method
/// locally (it then goes to the listener). `body` is the whole `rpc-call` request body.
pub fn build_payload(method: &str, body: &Value) -> Result<Option<String>, String> {
    let normalized = method.to_lowercase();
    let empty: Vec<Value> = Vec::new();
    let params: &Vec<Value> = match body.get("params") {
        Some(Value::Array(a)) => a,
        _ => match body {
            Value::Array(a) => a,
            _ => &empty,
        },
    };
    let empty_obj = Value::Object(serde_json::Map::new());
    let body_or_empty: &Value = if truthy(body) { body } else { &empty_obj };
    let source = Src(if params.len() == 1 && is_object_like(&params[0]) {
        &params[0]
    } else {
        body_or_empty
    });

    match normalized.as_str() {
        "tl_createpayload_attestation" => {
            let (revoke, id, target, meta): (String, Option<&Value>, String, String) =
                if params.len() >= 4 {
                    let s = |v: &Value| {
                        if truthy(v) {
                            js_string(v)
                        } else {
                            String::new()
                        }
                    };
                    (
                        if nullish(Some(&params[0])) {
                            "0".into()
                        } else {
                            js_string(&params[0])
                        },
                        Some(&params[1]),
                        s(&params[2]),
                        s(&params[3]),
                    )
                } else {
                    let a = Src(body_or_empty);
                    (
                        match a.p("revoke")? {
                            v if nullish(v) => "0".into(),
                            Some(v) => js_string(v),
                            None => "0".into(),
                        },
                        a.p("id")?,
                        a.or_str(&["targetAddress"])?,
                        a.or_str(&["metaData"])?,
                    )
                };
            Ok(Some(
                [
                    "tl9".to_string(),
                    revoke,
                    encode_base36(id, "0")?,
                    target,
                    meta,
                ]
                .join(","),
            ))
        }
        "tl_createpayload_commit_tochannel" => {
            let channel = source.or_str(&["channelAddress"])?;
            let clear_lists = match source.p("clearLists")? {
                Some(Value::Array(a)) => {
                    let items = a
                        .iter()
                        .map(|x| encode_base36(Some(x), "0"))
                        .collect::<Result<Vec<_>, _>>()?;
                    format!("[{}]", items.join(","))
                }
                Some(v) if truthy(v) => encode_base36(Some(v), "0")?,
                _ => String::new(),
            };
            let address = if channel.encode_utf16().count() > 42 {
                let r = match source.p("ref")? {
                    Some(v) if truthy(v) => js_string(v),
                    _ => "0".into(),
                };
                format!("ref:{r}")
            } else {
                channel
            };
            let mut payload = vec![
                encode_base36(source.p("propertyId")?, "0")?,
                encode_amount(source.p("amount")?)?,
                address,
                source.truthy_flag("payEnabled")?.into(),
                clear_lists,
                source.truthy_flag("isColoredOutput")?.into(),
            ];
            if let Some(Value::Number(n)) = source.p("commitClearlistId")? {
                if let Some(f) = n.as_f64().filter(|f| f.is_finite() && f.fract() == 0.0) {
                    payload.push(
                        base36_of_integer(f).ok_or_else(|| {
                            "number out of range for payload encoding".to_string()
                        })?,
                    );
                }
            }
            Ok(Some(format!("tl4{}", payload.join(","))))
        }
        "tl_createpayload_withdrawal_fromchannel" => Ok(Some(format!(
            "tll{}",
            [
                encode_base36(source.first(&["propertyId", "propertyid"])?, "0")?,
                encode_amount(source.p("amount")?)?,
                source.or_str(&["channelAddress", "address"])?,
                source.flag("isColoredOutput")?.to_string(),
            ]
            .join(",")
        ))),
        "tl_createpayload_simplesend" => {
            if source.p("sendAll")?.is_some_and(truthy) {
                return Ok(Some(format!(
                    "tl21;{}",
                    source.or_str(&["address", "toAddress"])?
                )));
            }
            Ok(Some(format!(
                "tl2{}",
                [
                    "0".to_string(),
                    source.or_str(&["address", "toAddress"])?,
                    encode_base36(source.first(&["propertyId", "propertyid"])?, "0")?,
                    encode_amount(source.p("amount")?)?,
                ]
                .join(";")
            )))
        }
        "tl_createpayload_instant_trade" | "tl_createpayload_instant_ltc_trade" => {
            let nullish_or_empty = |keys: &[&str]| -> Result<String, String> {
                Ok(match source.first(keys)? {
                    Some(v) => crate::jsval::js_string(v),
                    None => String::new(),
                })
            };
            Ok(Some(format!(
                "tl3{}",
                [
                    encode_base36(
                        source.first(&["propertyId", "propertyIdForSale", "propertyIdOffered"])?,
                        "0"
                    )?,
                    encode_amount(source.first(&["amount", "amountForSale", "amountOffered"])?)?,
                    nullish_or_empty(&["columnA", "column"])?,
                    encode_amount(source.first(&[
                        "satsExpected",
                        "amountDesired",
                        "expectedSats"
                    ])?)?,
                    nullish_or_empty(&["tokenOutput", "output"])?,
                    nullish_or_empty(&["payToAddress", "toAddress"])?,
                    source.flag("isColoredOutput")?.to_string(),
                ]
                .join(",")
            )))
        }
        "tl_createpayload_contract_instant_trade" => Ok(Some(format!(
            "tli{}",
            [
                encode_base36(source.p("contractId")?, "0")?,
                encode_amount(source.p("price")?)?,
                encode_base36(source.p("amount")?, "0")?,
                source.flag("sell")?.to_string(),
                source.flag("insurance")?.to_string(),
                source.flag("reduce")?.to_string(),
                source.flag("post")?.to_string(),
                source.flag("stop")?.to_string(),
            ]
            .join(",")
        ))),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unknown_methods_are_not_encoded_locally() {
        assert_eq!(build_payload("tl_getproperty", &json!({})).unwrap(), None);
        assert_eq!(
            build_payload(
                "tl_createpayload_sendactivation",
                &json!({"params":[1,2,3]})
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn a_null_single_param_throws_like_the_typescript() {
        let e =
            build_payload("tl_createpayload_simplesend", &json!({"params":[null]})).unwrap_err();
        assert!(e.contains("Cannot read properties of null"));
        // an unknown method never reads the source
        assert_eq!(
            build_payload("tl_other", &json!({"params":[null]})).unwrap(),
            None
        );
    }

    #[test]
    fn amounts_beyond_the_exact_range_are_refused() {
        let e = build_payload(
            "tl_createpayload_simplesend",
            &json!({"params":[{"address":"a","propertyId":1,"amount":1e9}]}),
        )
        .unwrap_err();
        assert!(e.contains("out of range"));
    }
}
