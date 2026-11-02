mod common;
use common::*;
use serde_json::Value;
use tl_wallet_service::amount::{Amount, AmountError};
use tl_wallet_service::orderform::*;

const VECTORS: &str = include_str!("../scripts/legacy-orderform.json");

fn coin(v: &Value) -> Amount {
    sat((v.as_f64().unwrap() * 1e8).round() as u64)
}

fn opt(v: &Value) -> Option<Amount> {
    if v.is_null() {
        None
    } else {
        Some(coin(v))
    }
}

struct Case {
    id: String,
    venue: Venue,
    balances: Balances,
    orders: Vec<OpenOrder>,
    is_limit: bool,
    current_price: Option<Amount>,
    input: FormInput,
    legacy: Value,
}

fn cases() -> Vec<Case> {
    let root: Value = serde_json::from_str(VECTORS).unwrap();
    root["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let venue = if c["kind"] == "spot" {
                Venue::Spot {
                    first: c["first"].as_i64().unwrap(),
                    second: c["second"].as_i64().unwrap(),
                    pair: "FIRST/SECOND".into(),
                }
            } else {
                Venue::Futures {
                    contract_id: 7,
                    collateral: c["collateral"].as_i64().unwrap(),
                    pair: "PERP".into(),
                }
            };
            let balances = Balances {
                ltc_confirmed: coin(&c["confirmed"]),
                utxos: c["utxos"].as_array().unwrap().iter().map(coin).collect(),
                tokens: c["tokens"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| (t[0].as_i64().unwrap(), coin(&t[1])))
                    .collect(),
            };
            let orders = c["orders"]
                .as_array()
                .unwrap()
                .iter()
                .map(|o| OpenOrder {
                    asset: o["asset"].as_i64().unwrap(),
                    side: if o["side"] == "SELL" {
                        Side::Sell
                    } else {
                        Side::Buy
                    },
                    amount: coin(&o["amount"]),
                    price: coin(&o["price"]),
                })
                .collect();
            Case {
                id: c["id"].as_str().unwrap().to_string(),
                venue,
                balances,
                orders,
                is_limit: c["isLimit"].as_bool().unwrap(),
                current_price: opt(&c["currentPrice"]),
                input: FormInput {
                    price: opt(&c["price"]),
                    amount: opt(&c["amount"]),
                },
                legacy: c["legacy"].clone(),
            }
        })
        .collect()
}

fn key() -> Option<KeyRef> {
    Some(KeyRef {
        address: "tltc1qexampleexampleexampleexampleexample".into(),
        pubkey: G.into(),
    })
}

fn ctx<'a>(c: &'a Case) -> CardContext<'a> {
    CardContext {
        venue: c.venue.clone(),
        key: key(),
        balances: &c.balances,
        open_orders: &c.orders,
        attested: true,
        current_price: c.current_price,
        is_limit: c.is_limit,
    }
}

fn by_id(id: &str) -> Case {
    cases().into_iter().find(|c| c.id == id).unwrap()
}

fn spot(first: i64, second: i64) -> Venue {
    Venue::Spot {
        first,
        second,
        pair: "T3/T5".into(),
    }
}

fn base_ctx<'a>(venue: Venue, b: &'a Balances, orders: &'a [OpenOrder]) -> CardContext<'a> {
    CardContext {
        venue,
        key: key(),
        balances: b,
        open_orders: orders,
        attested: true,
        current_price: None,
        is_limit: true,
    }
}

fn form(price: u64, amount: u64) -> FormInput {
    FormInput {
        price: Some(sat(price)),
        amount: Some(sat(amount)),
    }
}

const FEE_ONLY: [u64; 1] = [100_000_000];

fn tok_balances(entries: &[(i64, u64)], ltc: u64) -> Balances {
    Balances {
        ltc_confirmed: sat(ltc),
        utxos: FEE_ONLY.iter().map(|v| sat(*v)).collect(),
        tokens: entries.iter().map(|(i, b)| (*i, sat(*b))).collect(),
    }
}

// ---------------- legacy parity (pinned TS methods, see scripts/compare-orderform.cjs) ----------------

/// Cases whose fee estimate is the unchanged legacy contract (spot, funded by LTC as the quote or
/// by a token).
#[test]
fn fee_estimate_matches_legacy_get_fees_where_preserved() {
    let mut checked = 0;
    for c in cases() {
        if matches!(c.venue, Venue::Futures { .. }) || c.id == "spot_ltc_base_sell" {
            continue; // repaired, asserted below
        }
        for (side, key) in [(Side::Buy, "buy"), (Side::Sell, "sell")] {
            let want = c.legacy[key]["fee_sat"].as_u64().unwrap();
            let got = fee_estimate(&c.venue, side, &c.balances.utxos, c.input).unwrap();
            assert_eq!(got.sat(), want, "{} {key}", c.id);
            checked += 1;
        }
    }
    assert!(checked >= 24);
}

#[test]
fn repaired_fee_estimate_sell_of_ltc_funds_the_amount_not_amount_times_price() {
    // legacy: target 2 * 0.1 + min output -> phantom + one 1.0 input = 0.0012
    let c = by_id("spot_ltc_base_sell");
    assert_eq!(c.legacy["sell"]["fee_sat"].as_u64(), Some(120_000));
    // Rust: target 2.000036 -> the phantom and all three 1.0 inputs = 4 x 0.0006
    let fee = fee_estimate(&c.venue, Side::Sell, &c.balances.utxos, c.input).unwrap();
    assert_eq!(fee.sat(), 240_000);
    // BUY of the same market funds the token: unchanged
    let buy = fee_estimate(&c.venue, Side::Buy, &c.balances.utxos, c.input).unwrap();
    assert_eq!(buy.sat(), c.legacy["buy"]["fee_sat"].as_u64().unwrap());
    // the maximum SELL leaves room for its own fee
    let max = max_amount(&ctx(&c), Side::Sell, c.input).unwrap();
    assert_eq!(max.sat(), 299_760_000); // 3.0 - 4 x 0.0006 (legacy: 2.9988, fee for 2 inputs)
    assert_eq!(c.legacy["sell"]["max_sat"].as_u64(), Some(299_880_000));
}

#[test]
fn repaired_futures_fee_funds_tokens_not_ltc() {
    // legacy asked for amount*price (+0.000036) of LTC although the collateral is a token
    let c = by_id("futures_collateral_token");
    assert_eq!(c.legacy["buy"]["fee_sat"].as_u64(), Some(180_000));
    for side in [Side::Buy, Side::Sell] {
        let fee = fee_estimate(&c.venue, side, &c.balances.utxos, c.input).unwrap();
        assert_eq!(fee.sat(), 60_000); // one 0.01 input covers 2 x 0.000036
    }
}

#[test]
fn in_order_reservation_matches_legacy_for_buy_orders_and_ltc_fee_reserve() {
    for id in [
        "spot_token_token_open_buy_order",
        "spot_ltc_fee_reserve_per_open_order",
        "futures_open_order_collateral",
    ] {
        let c = by_id(id);
        for (prop, want) in c.legacy["in_order_sat"].as_object().unwrap() {
            let got = reserved_in_orders(&c.venue, &c.orders, prop.parse().unwrap()).unwrap();
            assert_eq!(got.sat(), want.as_u64().unwrap(), "{id} prop {prop}");
        }
    }
}

#[test]
fn repaired_sell_order_reserves_the_base_amount() {
    // open SELL of 4 tokens at 3: legacy reserved 4 * 3 = 12 tokens (> the whole balance of 10)
    let c = by_id("spot_open_sell_order_reservation");
    assert_eq!(c.legacy["in_order_sat"]["3"].as_u64(), Some(1_200_000_000));
    assert_eq!(c.legacy["sell"]["max_sat"].as_u64(), Some(0));
    let r = reserved_in_orders(&c.venue, &c.orders, 3).unwrap();
    assert_eq!(r.sat(), 400_000_000);
    let max = max_amount(&ctx(&c), Side::Sell, c.input).unwrap();
    assert_eq!(max.sat(), 600_000_000);
}

#[test]
fn max_amount_matches_legacy_when_legacy_stays_affordable() {
    // The legacy maximum is `available / price` rounded to the nearest 1e-6. Whenever that value
    // is affordable the new maximum is the exact floor: equal or higher, and within 1e-6.
    let mut compared = 0;
    for c in cases() {
        for (side, key) in [(Side::Buy, "buy"), (Side::Sell, "sell")] {
            let Some(legacy) = c.legacy[key]["max_sat"].as_u64() else {
                continue; // Infinity / NaN
            };
            let cx = ctx(&c);
            let got = max_amount(&cx, side, c.input).unwrap().sat();
            let ltc_funded =
                matches!(c.venue, Venue::Spot { .. }) && c.venue.for_sale(side) == LTC_PROPERTY;
            let repaired = matches!(c.venue, Venue::Futures { .. })
                || ltc_funded // fee is taken at the maximum, not at the typed amount
                || c.id == "spot_market_order_no_price"
                || c.id == "spot_open_sell_order_reservation"
                || c.id == "spot_max_rounds_up_over_balance";
            if repaired {
                continue;
            }
            assert!(
                got >= legacy && got - legacy <= 100,
                "{} {key}: legacy {legacy} rust {got}",
                c.id
            );
            compared += 1;
        }
    }
    assert!(compared >= 14, "compared {compared}");
}

#[test]
fn repaired_ltc_maximum_pays_the_fee_of_the_maximum_not_of_the_typed_amount() {
    // 0.75 LTC in three utxos, price 0.5, typed amount 0.2. Legacy: fee of the typed amount
    // (2 inputs, 0.0012) -> 1.4976, whose own order needs all four entries (0.0024).
    let c = by_id("spot_ltc_quote_buy_fee_and_max");
    let legacy = c.legacy["buy"]["max_sat"].as_u64().unwrap();
    assert_eq!(legacy, 149_760_000);
    let price = c.input.price.unwrap();
    let committed = cost(sat(legacy), price).unwrap().sat();
    let fee_at_legacy = fee_estimate(
        &c.venue,
        Side::Buy,
        &c.balances.utxos,
        FormInput {
            amount: Some(sat(legacy)),
            ..c.input
        },
    )
    .unwrap();
    assert_eq!(fee_at_legacy.sat(), 240_000);
    assert!(committed + fee_at_legacy.sat() > 75_000_000); // legacy "max" overdraws the balance
    let max = max_amount(&ctx(&c), Side::Buy, c.input).unwrap();
    assert_eq!(max.sat(), 149_520_000);
    assert_eq!(cost(max, price).unwrap().sat() + 240_000, 75_000_000);
}

#[test]
fn repaired_max_amount_never_costs_more_than_the_balance() {
    let c = by_id("spot_max_rounds_up_over_balance");
    // legacy 0.2 / 0.3 = 0.666667 (66 666 700 sat), whose cost is 0.2000001
    assert_eq!(c.legacy["buy"]["max_sat"].as_u64(), Some(66_666_700));
    let legacy_cost = cost(sat(66_666_700), c.input.price.unwrap()).unwrap();
    assert!(legacy_cost.sat() > 20_000_000);
    let max = max_amount(&ctx(&c), Side::Buy, c.input).unwrap();
    assert_eq!(max.sat(), 66_666_666);
    assert_eq!(cost(max, c.input.price.unwrap()).unwrap().sat(), 20_000_000);
    assert!(
        cost(sat(max.sat() + 1), c.input.price.unwrap())
            .unwrap()
            .sat()
            > 20_000_000
    );
    // exact division is unchanged
    let e = by_id("spot_max_exact_division");
    assert_eq!(e.legacy["buy"]["max_sat"].as_u64(), Some(300_000_000));
    assert_eq!(
        max_amount(&ctx(&e), Side::Buy, e.input).unwrap().sat(),
        300_000_000
    );
}

#[test]
fn repaired_market_order_without_a_price_has_no_maximum() {
    let c = by_id("spot_market_order_no_price");
    assert!(c.legacy["buy"]["max_sat"].is_null()); // Infinity
    assert_eq!(max_amount(&ctx(&c), Side::Buy, c.input).unwrap().sat(), 0);
    assert_eq!(max_amount(&ctx(&c), Side::Sell, c.input).unwrap().sat(), 0);
    assert!(button_disabled(&ctx(&c), Side::Buy, c.input));
    assert_eq!(
        build_order(&ctx(&c), Side::Buy, c.input),
        Err(OrderError::MissingPrice)
    );
    // with a current price the market order uses it, as legacy did
    let m = by_id("spot_market_order_with_price");
    assert_eq!(m.legacy["buy"]["max_sat"].as_u64(), Some(500_000_000));
    assert_eq!(
        max_amount(&ctx(&m), Side::Buy, m.input).unwrap().sat(),
        500_000_000
    );
    let o = build_order(&ctx(&m), Side::Buy, m.input).unwrap();
    assert_eq!(o.price.sat(), 400_000_000);
    assert!(!o.is_limit);
}

#[test]
fn repaired_futures_sell_maximum_is_priced() {
    let c = by_id("futures_sell_max_ignores_price");
    assert_eq!(c.legacy["sell"]["max_sat"].as_u64(), Some(2_000_000_000)); // 20 contracts at price 4
    let sell = max_amount(&ctx(&c), Side::Sell, c.input).unwrap();
    let buy = max_amount(&ctx(&c), Side::Buy, c.input).unwrap();
    assert_eq!(sell.sat(), 500_000_000);
    assert_eq!(buy, sell);
    assert_eq!(c.legacy["buy"]["max_sat"].as_u64(), Some(500_000_000));
}

#[test]
fn total_display_matches_legacy_get_total() {
    for c in cases() {
        if matches!(c.venue, Venue::Futures { .. }) {
            continue;
        }
        let (first, second) = ("FIRST", "SECOND");
        for (side, key, name) in [(Side::Buy, "buy", second), (Side::Sell, "sell", first)] {
            let want = c.legacy[key]["total"].as_str().unwrap();
            assert_eq!(
                total_display(side, c.input, name).unwrap(),
                want,
                "{}",
                c.id
            );
        }
    }
    // toFixed(4) boundary: 0.00005 -> 0.0001 (decimal half-up on the exact integer)
    let f = FormInput {
        price: Some(sat(500_000)),
        amount: Some(sat(1_000_000)),
    };
    assert_eq!(total_display(Side::Buy, f, "X").unwrap(), "0.0001 X");
}

// ---------------- order construction ----------------

#[test]
fn spot_buy_builds_the_legacy_socket_payload() {
    let b = tok_balances(&[(3, 500_000_000), (5, 2_000_000_000)], 1_000_000);
    let v = spot(3, 5);
    let cx = base_ctx(v, &b, &[]);
    let o = build_order(&cx, Side::Buy, form(200_000_000, 300_000_000)).unwrap();
    let j = o.to_json();
    assert_eq!(j["action"], "BUY");
    assert_eq!(j["type"], "SPOT");
    assert_eq!(j["isLimitOrder"], true);
    assert_eq!(j["marketName"], "T3/T5");
    assert_eq!(j["keypair"]["pubkey"], G);
    assert_eq!(j["props"]["id_desired"], 3);
    assert_eq!(j["props"]["id_for_sale"], 5);
    assert_eq!(j["props"]["amount"].as_f64(), Some(3.0));
    assert_eq!(j["props"]["price"].as_f64(), Some(2.0));
    let s = build_order(&cx, Side::Sell, form(200_000_000, 300_000_000)).unwrap();
    assert_eq!(s.to_json()["props"]["id_for_sale"], 3);
    assert_eq!(s.to_json()["props"]["id_desired"], 5);
}

#[test]
fn futures_order_keeps_the_levarage_wire_name() {
    let b = tok_balances(&[(5, 2_000_000_000)], 1_000_000);
    let v = Venue::Futures {
        contract_id: 7,
        collateral: 5,
        pair: "PERP".into(),
    };
    let cx = base_ctx(v, &b, &[]);
    let o = build_order(&cx, Side::Sell, form(200_000_000, 300_000_000)).unwrap();
    let j = o.to_json();
    assert_eq!(j["type"], "FUTURES");
    assert_eq!(j["action"], "SELL");
    assert_eq!(j["props"]["contract_id"], 7);
    assert_eq!(j["props"]["collateral"], 5);
    assert_eq!(j["props"]["levarage"], 1);
    assert!(j["props"].get("leverage").is_none());
}

#[test]
fn repaired_handler_enforces_the_balance_the_template_only_hinted_at() {
    // 20 tokens of 5 at price 2: at most 10 base units. Legacy handleBuySell accepted 10.5.
    let b = tok_balances(&[(5, 2_000_000_000)], 1_000_000);
    let cx = base_ctx(spot(3, 5), &b, &[]);
    assert!(build_order(&cx, Side::Buy, form(200_000_000, 1_000_000_000)).is_ok());
    assert_eq!(
        build_order(&cx, Side::Buy, form(200_000_000, 1_050_000_000)),
        Err(OrderError::ExceedsAvailable {
            max: sat(1_000_000_000)
        })
    );
    assert!(button_disabled(
        &cx,
        Side::Buy,
        form(200_000_000, 1_050_000_000)
    ));
    assert!(!button_disabled(
        &cx,
        Side::Buy,
        form(200_000_000, 1_000_000_000)
    ));
    // open orders count against the balance
    let orders = [OpenOrder {
        asset: 5,
        side: Side::Buy,
        amount: sat(500_000_000),
        price: sat(200_000_000),
    }];
    let cx2 = base_ctx(spot(3, 5), &b, &orders);
    assert!(build_order(&cx2, Side::Buy, form(200_000_000, 500_000_000)).is_ok());
    assert!(build_order(&cx2, Side::Buy, form(200_000_000, 500_000_001)).is_err());
}

#[test]
fn order_error_paths_and_their_order() {
    let b = tok_balances(&[(3, 500_000_000), (5, 2_000_000_000)], 1_000_000);
    let f = form(200_000_000, 100_000_000);
    // LTC for the fee (0.0006) first
    let poor = tok_balances(&[(5, 2_000_000_000)], 59_999);
    let cx = base_ctx(spot(3, 5), &poor, &[]);
    assert_eq!(
        build_order(&cx, Side::Buy, f),
        Err(OrderError::NeedLtc { fee: sat(60_000) })
    );
    // then attestation
    let mut cx = base_ctx(spot(3, 5), &b, &[]);
    cx.attested = false;
    assert_eq!(build_order(&cx, Side::Buy, f), Err(OrderError::NotAttested));
    cx.attested = true;
    // markets
    for v in [spot(0, 5), spot(3, 0), spot(5, 5)] {
        let cx = base_ctx(v, &b, &[]);
        assert_eq!(build_order(&cx, Side::Buy, f), Err(OrderError::BadMarket));
    }
    let cx = base_ctx(
        Venue::Futures {
            contract_id: 0,
            collateral: 5,
            pair: "P".into(),
        },
        &b,
        &[],
    );
    assert_eq!(build_order(&cx, Side::Buy, f), Err(OrderError::BadContract));
    // missing / below minimum controls
    let cx = base_ctx(spot(3, 5), &b, &[]);
    let none = FormInput {
        price: None,
        amount: Some(sat(100_000_000)),
    };
    assert_eq!(
        build_order(&cx, Side::Buy, none),
        Err(OrderError::MissingPrice)
    );
    let none = FormInput {
        price: Some(sat(100_000_000)),
        amount: None,
    };
    assert_eq!(
        build_order(&cx, Side::Buy, none),
        Err(OrderError::MissingAmount)
    );
    assert_eq!(
        build_order(&cx, Side::Buy, form(999_999, 100_000_000)),
        Err(OrderError::BelowFormMinimum)
    );
    assert_eq!(
        build_order(&cx, Side::Buy, form(100_000_000, 999_999)),
        Err(OrderError::BelowFormMinimum)
    );
    // no key pair
    let mut cx = base_ctx(spot(3, 5), &b, &[]);
    cx.key = None;
    assert_eq!(build_order(&cx, Side::Buy, f), Err(OrderError::NoKey));
    assert_eq!(max_amount(&cx, Side::Buy, f).unwrap().sat(), 0);
}

#[test]
fn ltc_orders_pay_their_own_fee_out_of_the_balance() {
    // spot LTC quote: 1 LTC confirmed in one utxo, price 0.5 -> not 2 but 2 - fee/price
    let b = Balances {
        ltc_confirmed: sat(100_000_000),
        utxos: vec![sat(100_000_000)],
        tokens: vec![],
    };
    let cx = base_ctx(spot(3, -1), &b, &[]);
    let f = form(50_000_000, 100_000_000);
    // fee: phantom + the 1.0 input = 2 x 0.0006
    assert_eq!(
        fee_estimate(&cx.venue, Side::Buy, &b.utxos, f)
            .unwrap()
            .sat(),
        120_000
    );
    let max = max_amount(&cx, Side::Buy, f).unwrap();
    assert_eq!(max.sat(), 199_760_000); // (1 - 0.0012) / 0.5
    assert!(build_order(
        &cx,
        Side::Buy,
        FormInput {
            amount: Some(max),
            ..f
        }
    )
    .is_ok());
    assert!(matches!(
        build_order(
            &cx,
            Side::Buy,
            FormInput {
                amount: Some(sat(max.sat() + 1)),
                ..f
            }
        ),
        Err(OrderError::ExceedsAvailable { .. })
    ));
}

#[test]
fn maximum_is_exact_over_a_grid() {
    // For many balances/prices: build_order accepts the maximum and refuses one more unit, the
    // committed quantity never exceeds balance - reservations (- fee for LTC).
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    let mut next = |m: u64| {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 33) % m
    };
    let mut accepted = 0;
    for round in 0..400 {
        let n = (next(5) + 1) as usize;
        let utxos: Vec<Amount> = (0..n).map(|_| sat(50_000 + next(300_000_000))).collect();
        let ltc: u64 = utxos.iter().map(|u| u.sat()).sum();
        let token = 1_000_000 + next(5_000_000_000);
        let price = 1_000_000 + next(900_000_000);
        let b = Balances {
            ltc_confirmed: sat(ltc),
            utxos,
            tokens: vec![(5, sat(token)), (3, sat(token))],
        };
        let orders = if round % 3 == 0 {
            vec![OpenOrder {
                asset: 5,
                side: Side::Buy,
                amount: sat(next(100_000_000)),
                price: sat(price),
            }]
        } else {
            vec![]
        };
        for (venue, side) in [
            (spot(3, 5), Side::Buy),
            (spot(3, 5), Side::Sell),
            (spot(3, -1), Side::Buy),
            (spot(-1, 3), Side::Sell),
            (
                Venue::Futures {
                    contract_id: 9,
                    collateral: 5,
                    pair: "P".into(),
                },
                Side::Sell,
            ),
        ] {
            let cx = base_ctx(venue, &b, &orders);
            let seed = form(price, 100_000_000);
            let max = max_amount(&cx, side, seed).unwrap();
            if max.sat() >= FORM_MIN_SAT {
                let f = FormInput {
                    amount: Some(max),
                    ..seed
                };
                match build_order(&cx, side, f) {
                    Ok(_) => accepted += 1,
                    Err(OrderError::NeedLtc { .. }) => continue,
                    Err(e) => panic!("max {max:?} refused: {e:?} (round {round})"),
                }
                let over = FormInput {
                    amount: Some(sat(max.sat() + 1)),
                    ..seed
                };
                assert!(
                    matches!(
                        build_order(&cx, side, over),
                        Err(OrderError::ExceedsAvailable { .. }) | Err(OrderError::NeedLtc { .. })
                    ),
                    "max+1 accepted (round {round}, {:?})",
                    cx.venue
                );
            }
        }
    }
    assert!(accepted > 600, "accepted {accepted}");
}

// ---------------- helpers ----------------

#[test]
fn cost_rounds_up_and_budget_rounds_down() {
    assert_eq!(
        cost(sat(100_000_000), sat(30_000_000)).unwrap().sat(),
        30_000_000
    );
    assert_eq!(cost(sat(1), sat(1)).unwrap().sat(), 1); // never zero for a non-zero order
    assert_eq!(cost(sat(0), sat(5)).unwrap().sat(), 0);
    assert_eq!(
        cost(
            Amount::from_sat(8_400_000_000_000_000).unwrap(),
            sat(200_000_000)
        ),
        Err(AmountError::OutOfRange)
    );
    assert_eq!(
        max_for_budget(sat(20_000_000), sat(30_000_000)).sat(),
        66_666_666
    );
    assert_eq!(max_for_budget(sat(5), sat(0)).sat(), 0);
}

#[test]
fn control_parsing_refuses_exponents_and_extra_decimals() {
    assert_eq!(parse_control("").unwrap(), None);
    assert_eq!(parse_control(" 1.5 ").unwrap().unwrap().sat(), 150_000_000);
    assert_eq!(parse_control("1e-7"), Err(AmountError::Malformed));
    assert_eq!(
        parse_control("0.123456789"),
        Err(AmountError::TooManyDecimals)
    );
    assert_eq!(parse_control("-1"), Err(AmountError::Negative));
}
