//! FE-speed's listener contract against `tradelayer-listenerd`.
//!
//! `tradelayer-listenerd` serves the pinned `listener.js` / `walletListener.js` routes, so the
//! passthrough needs no adapter. Where the daemon's reply differs from what FE-speed's UI
//! parses, [`ListenerClient`](super::fespeed::ListenerClient) applies the small, additive
//! mappings in this module. Each one is keyed on a marker only the daemon's shape carries, so a
//! Node listener's replies pass through untouched:
//!
//! | endpoint | daemon answers | mapped to what the UI reads |
//! |---|---|---|
//! | `tl_getAllBalancesForAddress` | rows `{propertyId, availableAtoms, contractMarginAtoms, contractReserveAtoms, spotReserveAtoms, channelAtoms, ownedAtoms, available:"79899.85"}` | adds JSON numbers `amount`, `available`, `reserved`, `margin`, `channel` (atoms / 1e8); the atom fields stay |
//! | `tl_listProperties`, `tl_getProperty` | `propertyId` only | adds `id` |
//! | `tl_contractPosition` | `{contracts, averagePrice, marginAtoms, unrealizedPnl}` | adds `avgPrice`, `margin`, `unrealizedPNL` (numbers) |
//! | `tl_getChannel` | `404 {"error":"not_found"}` for an unknown channel | `200 {"message":"No channel found for the given address","channel":null}`, the reply the listener gives for no channel |
//! | `tl_getSyncStatus` (not a route of the pinned listener) | `404 {"error":"not_found"}` | the daemon's `tl_checkSync` answer with `initialized:true` and `source:"listenerd"` |
//! | `tl_getStateSnapshot`, `tl_watchonly_register`, `tl_watchonly_utxos` | `404 {"error":"not_found"}` | `503 {"error":"unavailable","capability":...}`, the daemon's own typed-unavailable shape |
//!
//! Request bodies: a `{params:[x]}` single-element array becomes `{params:x}` for the routes the
//! daemon takes a scalar `params` on (`rpc-call` of a lower-case `tl_*` method sends the array),
//! and `tl_getChannelColumn` gets `newCommitAddress` from `buyerAddress`/`myAddress` (the UI's
//! direct call names the buyer; the listener reads `newCommitAddress`).
//!
//! Nothing is invented: a field the daemon does not serve (`ticker`, `vesting`,
//! `bankruptcyPrice`, channel rows) stays absent.

use serde_json::{json, Map, Number, Value};
use tl_wallet_service::service::ListenerReply;

const ATOM_DIGITS: usize = 8;

fn is(endpoint: &str, name: &str) -> bool {
    endpoint.eq_ignore_ascii_case(name)
}

/// `404 {"error":"not_found"}`: the daemon's answer for a route it does not have, and for an
/// unknown channel. A Node listener's 404 is Express's HTML page and never matches.
pub fn is_not_found(r: &ListenerReply) -> bool {
    r.status == 404 && r.body.get("error").and_then(Value::as_str) == Some("not_found")
}

fn unavailable(capability: &str) -> ListenerReply {
    ListenerReply {
        status: 503,
        body: json!({ "error": "unavailable", "capability": capability }),
    }
}

/// Atoms as units: a JSON number, `atoms / 1e8`.
fn atoms_to_number(atoms: u128) -> Option<Number> {
    let digits = atoms.to_string();
    let padded = format!("{digits:0>width$}", width = ATOM_DIGITS + 1);
    let (whole, frac) = padded.split_at(padded.len() - ATOM_DIGITS);
    let n: f64 = format!("{whole}.{frac}").parse().ok()?;
    Number::from_f64(n)
}

/// An unsigned decimal string field as atoms.
fn atoms_of(row: &Value, key: &str) -> Option<u128> {
    let s = row.get(key)?.as_str()?;
    if s.is_empty() || s.len() > 38 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// A decimal string (`"12.5"`, `"-3"`) or number as a JSON number.
fn decimal_to_number(v: &Value) -> Option<Number> {
    match v {
        Value::Number(n) => Some(n.clone()),
        Value::String(s) => Number::from_f64(s.trim().parse::<f64>().ok()?),
        _ => None,
    }
}

fn balance_row(row: &Value) -> Option<Value> {
    // the daemon's rows carry `ownedAtoms`; a row without it is already FE-speed's shape
    let owned = atoms_of(row, "ownedAtoms")?;
    let available = atoms_of(row, "availableAtoms")?;
    let margin = atoms_of(row, "contractMarginAtoms")?;
    let reserved =
        atoms_of(row, "contractReserveAtoms")?.checked_add(atoms_of(row, "spotReserveAtoms")?)?;
    let channel = atoms_of(row, "channelAtoms")?;
    let mut out = row.as_object()?.clone();
    out.insert("amount".into(), Value::Number(atoms_to_number(owned)?));
    out.insert(
        "available".into(),
        Value::Number(atoms_to_number(available)?),
    );
    out.insert("reserved".into(), Value::Number(atoms_to_number(reserved)?));
    out.insert("margin".into(), Value::Number(atoms_to_number(margin)?));
    out.insert("channel".into(), Value::Number(atoms_to_number(channel)?));
    Some(Value::Object(out))
}

fn with_id(row: &Value) -> Value {
    match row {
        Value::Object(m) if !m.contains_key("id") => {
            let mut m = m.clone();
            if let Some(id) = m.get("propertyId").cloned() {
                m.insert("id".into(), id);
            }
            Value::Object(m)
        }
        other => other.clone(),
    }
}

fn position(row: &Value) -> Option<Value> {
    let m = row.as_object()?;
    if !m.contains_key("averagePrice") && !m.contains_key("marginAtoms") {
        return None;
    }
    let mut out = m.clone();
    if let Some(n) = m.get("averagePrice").and_then(decimal_to_number) {
        out.insert("avgPrice".into(), Value::Number(n));
    }
    if let Some(n) = atoms_of(row, "marginAtoms").and_then(atoms_to_number) {
        out.insert("margin".into(), Value::Number(n));
    }
    if let Some(n) = m.get("unrealizedPnl").and_then(decimal_to_number) {
        out.insert("unrealizedPNL".into(), Value::Number(n));
    }
    if let Some(n) = m.get("contracts").and_then(decimal_to_number) {
        out.insert("contracts".into(), Value::Number(n));
    }
    Some(Value::Object(out))
}

/// The request body the daemon accepts for what FE-speed's UI or `rpc-call` sends; `None` keeps
/// the body as it is.
pub fn map_request(method: &str, endpoint: &str, body: Option<&Value>) -> Option<Value> {
    if method != "POST" {
        return None;
    }
    let obj = body?.as_object()?;
    if is(endpoint, "tl_getChannelColumn") {
        if obj.contains_key("newCommitAddress") {
            return None;
        }
        let mine = ["myAddress", "myAddr", "buyerAddress"]
            .iter()
            .find_map(|k| {
                obj.get(*k)
                    .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            })?;
        let mut m = obj.clone();
        m.insert("newCommitAddress".into(), mine.clone());
        return Some(Value::Object(m));
    }
    if is(endpoint, "tl_getProperty")
        || is(endpoint, "tl_getChannel")
        || is(endpoint, "tl_getAllBalancesForAddress")
    {
        let [one] = obj.get("params")?.as_array()?.as_slice() else {
            return None;
        };
        // `method` is the rpc-call envelope, not a parameter of the route
        let mut m = Map::new();
        m.insert("params".into(), one.clone());
        return Some(Value::Object(m));
    }
    None
}

/// The reply FE-speed's UI parses for the daemon's reply (see the module table).
pub fn map_reply(method: &str, endpoint: &str, reply: ListenerReply) -> ListenerReply {
    if is_not_found(&reply) && method == "POST" {
        if is(endpoint, "tl_getChannel") {
            return ListenerReply {
                status: 200,
                body: json!({ "message": "No channel found for the given address", "channel": null }),
            };
        }
        if is(endpoint, "tl_getStateSnapshot") {
            return unavailable("state_snapshot");
        }
        if is(endpoint, "tl_watchonly_register") || is(endpoint, "tl_watchonly_utxos") {
            return unavailable("watchonly_index");
        }
    }
    if !(200..300).contains(&reply.status) {
        return reply;
    }
    let body = if is(endpoint, "tl_getAllBalancesForAddress") {
        match &reply.body {
            Value::Array(rows) => Value::Array(
                rows.iter()
                    .map(|r| balance_row(r).unwrap_or_else(|| r.clone()))
                    .collect(),
            ),
            other => other.clone(),
        }
    } else if is(endpoint, "tl_listProperties") {
        match &reply.body {
            Value::Array(rows) => Value::Array(rows.iter().map(with_id).collect()),
            other => other.clone(),
        }
    } else if is(endpoint, "tl_getProperty") {
        with_id(&reply.body)
    } else if is(endpoint, "tl_contractPosition") {
        position(&reply.body).unwrap_or_else(|| reply.body.clone())
    } else {
        return reply;
    };
    ListenerReply {
        status: reply.status,
        body,
    }
}

/// `tl_getSyncStatus` for a daemon without that route: its `tl_checkSync` answer, marked with
/// its source. `initialized` is true because the daemon answered from the store it restored;
/// `available:false` and `synced:null` stay as the daemon reports them (no chain ingest).
pub fn sync_status(check: &ListenerReply) -> Option<ListenerReply> {
    if !(200..300).contains(&check.status) {
        return None;
    }
    let mut m = check.body.as_object()?.clone();
    m.insert("source".into(), json!("listenerd"));
    m.insert("initialized".into(), json!(true));
    Some(ListenerReply {
        status: 200,
        body: Value::Object(m),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(body: Value) -> ListenerReply {
        ListenerReply { status: 200, body }
    }

    fn daemon_balance() -> Value {
        json!({
            "propertyId": 7, "address": "DemoAlice",
            "availableAtoms": "7989985000000", "available": "79899.85",
            "contractMarginAtoms": "2000000000000", "contractReserveAtoms": "100000000",
            "spotReserveAtoms": "50000000", "channelAtoms": "3",
            "pendingWithdrawalAtoms": "0", "ownedAtoms": "9990135000003"
        })
    }

    #[test]
    fn balances_gain_the_number_fields_the_ui_reads_and_keep_the_atoms() {
        let r = map_reply(
            "POST",
            "tl_getAllBalancesForAddress",
            ok(json!([daemon_balance()])),
        );
        let row = &r.body[0];
        assert_eq!(row["amount"], json!(99901.35000003));
        assert_eq!(row["available"], json!(79899.85));
        assert_eq!(row["reserved"], json!(1.5));
        assert_eq!(row["margin"], json!(20000.0));
        assert_eq!(row["channel"], json!(3e-8));
        assert_eq!(row["ownedAtoms"], json!("9990135000003"));
        assert_eq!(row["propertyId"], json!(7));
        assert!(row.get("vesting").is_none() && row.get("ticker").is_none());
    }

    #[test]
    fn a_node_listeners_rows_and_errors_pass_through_untouched() {
        let node = json!([{"propertyId": 1, "amount": 5.0, "available": 4.0, "reserved": 1.0}]);
        let r = map_reply("POST", "tl_getAllBalancesForAddress", ok(node.clone()));
        assert_eq!(r.body, node);
        let err = ListenerReply {
            status: 500,
            body: json!("Error: x"),
        };
        assert_eq!(
            map_reply("POST", "tl_getAllBalancesForAddress", err.clone()),
            err
        );
        // Express's 404 is not the daemon's
        let express = ListenerReply {
            status: 404,
            body: json!("Cannot POST /tl_getChannel"),
        };
        assert_eq!(map_reply("POST", "tl_getChannel", express.clone()), express);
    }

    #[test]
    fn properties_gain_id_and_positions_gain_the_legacy_names() {
        let p = json!({"propertyId": 9, "issuer": "DemoIssuer", "totalSupplyAtoms": "1"});
        assert_eq!(
            map_reply("POST", "tl_getProperty", ok(p.clone())).body["id"],
            json!(9)
        );
        let l = map_reply("POST", "tl_listProperties", ok(json!([p.clone()])));
        assert_eq!(l.body[0]["id"], json!(9));
        let pos = json!({"address":"a","contractId":1,"contracts":"2","averagePrice":"100150","marginAtoms":"2000000000000","unrealizedPnl":"-12.5","settledBasis":null});
        let r = map_reply("GET", "tl_contractPosition", ok(pos));
        assert_eq!(
            (
                r.body["contracts"].clone(),
                r.body["avgPrice"].clone(),
                r.body["margin"].clone(),
                r.body["unrealizedPNL"].clone()
            ),
            (json!(2.0), json!(100150.0), json!(20000.0), json!(-12.5))
        );
        assert!(r.body.get("bankruptcyPrice").is_none());
    }

    #[test]
    fn unknown_channel_and_unbacked_routes_get_the_shapes_the_ui_tolerates() {
        let nf = ListenerReply {
            status: 404,
            body: json!({"error": "not_found"}),
        };
        let ch = map_reply("POST", "tl_getChannel", nf.clone());
        assert_eq!((ch.status, ch.body["channel"].clone()), (200, Value::Null));
        for (name, cap) in [
            ("tl_getStateSnapshot", "state_snapshot"),
            ("tl_watchonly_register", "watchonly_index"),
            ("tl_watchonly_utxos", "watchonly_index"),
        ] {
            let r = map_reply("POST", name, nf.clone());
            assert_eq!(
                (r.status, r.body["capability"].clone()),
                (503, json!(cap)),
                "{name}"
            );
        }
        // a 404 on any other route stays a 404
        assert_eq!(map_reply("POST", "tl_getTransaction", nf.clone()), nf);
    }

    #[test]
    fn request_bodies_are_mapped_for_scalar_params_and_the_column_buyer() {
        let b = json!({"method": "tl_getproperty", "params": [7]});
        assert_eq!(
            map_request("POST", "tl_getproperty", Some(&b)),
            Some(json!({"params": 7}))
        );
        let two = json!({"params": [1, 2]});
        assert_eq!(map_request("POST", "tl_getProperty", Some(&two)), None);
        let scalar = json!({"params": 7});
        assert_eq!(map_request("POST", "tl_getProperty", Some(&scalar)), None);
        let col = json!({"channelAddress": "c", "buyerAddress": "b", "cpAddress": "p"});
        let m = map_request("POST", "tl_getChannelColumn", Some(&col)).unwrap();
        assert_eq!(m["newCommitAddress"], json!("b"));
        assert_eq!(m["buyerAddress"], json!("b"));
        let has = json!({"channelAddress": "c", "newCommitAddress": "n", "buyerAddress": "b"});
        assert_eq!(map_request("POST", "tl_getChannelColumn", Some(&has)), None);
        assert_eq!(map_request("GET", "tl_getProperty", Some(&b)), None);
    }

    #[test]
    fn sync_status_is_the_check_sync_answer_marked_as_the_daemons() {
        let check = ok(
            json!({"available": false, "consensus": 4, "txIndex": null, "trackHeight": null, "synced": null}),
        );
        let s = sync_status(&check).unwrap();
        assert_eq!(s.status, 200);
        assert_eq!(s.body["initialized"], json!(true));
        assert_eq!(s.body["source"], json!("listenerd"));
        assert_eq!(s.body["consensus"], json!(4));
        assert_eq!(s.body["synced"], Value::Null);
        assert!(sync_status(&ListenerReply {
            status: 503,
            body: json!({})
        })
        .is_none());
    }
}
