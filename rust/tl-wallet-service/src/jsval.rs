//! JavaScript value semantics over `serde_json::Value`.
//!
//! FE-speed's wallet-server builds payload strings from untyped request bodies with `Number(x)`,
//! `x || ''`, `x ?? y`, `String(x)`, `Array.prototype.join` and `Number.prototype.toString(36)`.
//! The Rust port has to produce the same bytes for the same bodies, so these helpers follow the
//! ECMAScript rules (and V8's radix conversion) instead of Rust's.

use serde_json::Value;

/// ECMAScript `ToBoolean`.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `v == null`: missing, or JSON `null` (the operand of `??`).
pub fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

/// ECMAScript `String(v)` for a JSON value.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `Number::toString` for the cases a JSON number can reach.
pub fn number_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x == 0.0 {
        return "0".into();
    }
    let a = x.abs();
    if !(1e-6..1e21).contains(&a) {
        let s = format!("{x:e}");
        return match s.split_once('e') {
            Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
            _ => s,
        };
    }
    format!("{x}")
}

fn str_to_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(rest) = t.strip_prefix(prefix) {
            if rest.is_empty() {
                return f64::NAN;
            }
            let mut acc = 0f64;
            for c in rest.chars() {
                match c.to_digit(radix) {
                    Some(d) => acc = acc * f64::from(radix) + f64::from(d),
                    None => return f64::NAN,
                }
            }
            return acc;
        }
    }
    if !t
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// ECMAScript `Number(v)`; a missing value is `undefined`, so `NaN`.
pub fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(other) => str_to_number(&js_string(other)),
    }
}

/// `Math.round`: ties go toward positive infinity.
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// Largest magnitude whose base-36 digits are the exact digits of the double. Above 2^55 V8
/// drops digits it considers unrepresentable, which the port does not reproduce; payload
/// encoding refuses those values instead of emitting different bytes.
pub const BASE36_LIMIT: f64 = 36_028_797_018_963_968.0;

/// Base-36 digits of the truncated integer, for a finite value with magnitude below 2^55;
/// None beyond that.
pub fn base36_of_integer(n: f64) -> Option<String> {
    const CHARS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let t = n.trunc();
    if !t.is_finite() || t.abs() >= BASE36_LIMIT {
        return None;
    }
    if t == 0.0 {
        return Some("0".into());
    }
    let mut x = t.abs() as u64;
    let mut rev: Vec<u8> = Vec::new();
    while x > 0 {
        rev.push(CHARS[(x % 36) as usize]);
        x /= 36;
    }
    if t < 0.0 {
        rev.push(b'-');
    }
    rev.reverse();
    String::from_utf8(rev).ok()
}

/// The encodeBase36 helper of FE-speed's rpc-proxy.service.ts.
pub fn encode_base36(v: Option<&Value>, fallback: &str) -> Result<String, String> {
    match v {
        None | Some(Value::Null) => return Ok(fallback.into()),
        Some(Value::String(s)) if s.is_empty() => return Ok(fallback.into()),
        _ => {}
    }
    let n = to_number(v);
    if !n.is_finite() {
        return Ok(fallback.into());
    }
    base36_of_integer(n).ok_or_else(|| "number out of range for payload encoding".to_string())
}

/// `encodeAmount`: `Math.round(Number(v) * 1e8).toString(36)`, `0` when not finite.
pub fn encode_amount(v: Option<&Value>) -> Result<String, String> {
    let n = to_number(v);
    if !n.is_finite() {
        return Ok("0".into());
    }
    base36_of_integer(round(n * 1e8))
        .ok_or_else(|| "amount out of range for payload encoding".to_string())
}

/// `encodeBoolean`: strictly `true`, `1` or `'1'`.
pub fn encode_boolean(v: Option<&Value>) -> &'static str {
    let yes = match v {
        Some(Value::Bool(true)) => true,
        Some(Value::Number(n)) => n.as_f64() == Some(1.0),
        Some(Value::String(s)) => s == "1",
        _ => false,
    };
    if yes {
        "1"
    } else {
        "0"
    }
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_conversion_follows_ecmascript() {
        let n = |v: Value| to_number(Some(&v));
        assert_eq!(n(json!("")), 0.0);
        assert_eq!(n(json!("  12 ")), 12.0);
        assert_eq!(n(json!("0x10")), 16.0);
        assert_eq!(n(json!("1e3")), 1000.0);
        assert_eq!(n(json!(".5")), 0.5);
        assert!(n(json!("abc")).is_nan());
        assert!(n(json!("inf")).is_nan());
        assert!(n(json!("nan")).is_nan());
        assert_eq!(n(json!(null)), 0.0);
        assert_eq!(n(json!(true)), 1.0);
        assert_eq!(n(json!([])), 0.0);
        assert_eq!(n(json!([7])), 7.0);
        assert!(n(json!({})).is_nan());
        assert!(to_number(None).is_nan());
    }

    #[test]
    fn base36_matches_v8_below_the_limit() {
        let b = |x: f64| base36_of_integer(x).unwrap();
        assert_eq!(b(0.0), "0");
        assert_eq!(b(-0.0), "0");
        assert_eq!(b(35.0), "z");
        assert_eq!(b(36.0), "10");
        assert_eq!(b(-36.9), "-10");
        assert_eq!(b(1e8), "1njchs");
        assert_eq!(b(-37.0), "-11");
        assert_eq!(b(9_007_199_254_740_992.0), "2gosa7pa2gw");
        assert_eq!(b(2f64.powi(54)), "4xdkkfek4xs");
        assert!(base36_of_integer(2f64.powi(55)).is_none());
        assert!(base36_of_integer(1e21).is_none());
    }

    #[test]
    fn round_ties_go_up() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(-2.6), -3.0);
        assert_eq!(round(0.49999999999999994), 0.0);
    }

    #[test]
    fn string_forms() {
        assert_eq!(js_string(&json!(1.5)), "1.5");
        assert_eq!(js_string(&json!(1e21)), "1e+21");
        assert_eq!(js_string(&json!(1e-7)), "1e-7");
        assert_eq!(js_string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(js_string(&json!({})), "[object Object]");
        assert_eq!(encode_uri_component("a b&c/é"), "a%20b%26c%2F%C3%A9");
        assert!(!truthy(&json!(0)) && !truthy(&json!("")) && truthy(&json!("0")));
    }
}
