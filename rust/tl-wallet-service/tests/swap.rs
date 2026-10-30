mod common;
use common::*;
use tl_wallet_service::amount::Amount;
use tl_wallet_service::swap::checks::*;
use tl_wallet_service::swap::machine::*;
use tl_wallet_service::swap::manager::*;
use tl_wallet_service::swap::order::*;
use tl_wallet_service::swap::types::*;

fn sid(s: &str) -> SessionId {
    SessionId::parse(s).unwrap()
}

fn kp(addr: &str, pk: &str) -> KeyPair {
    KeyPair {
        address: addr.into(),
        pubkey: pk.into(),
    }
}

const BTC_ID: i64 = 5;
const USD_ID: i64 = 7;

/// Spot trade: buyer wants `desired` of token 5 and pays `for_sale` of token 7.
fn spot(desired: u64, for_sale: u64) -> TradeInfo {
    TradeInfo {
        buyer: Party {
            keypair: kp("buyerAddr", G),
            session: sid("sockB"),
        },
        seller: Party {
            keypair: kp("sellerAddr", G2),
            session: sid("sockS"),
        },
        taker: sid("sockB"),
        maker: sid("sockS"),
        kind: TradeKind::Spot(SpotProps {
            amount_desired: sat(desired),
            amount_for_sale: sat(for_sale),
            prop_id_desired: BTC_ID,
            prop_id_for_sale: USD_ID,
        }),
    }
}

fn buy_order(uuid: &str, amount: u64, limit: Option<u64>) -> OrderTerms {
    OrderTerms {
        uuid: uuid.into(),
        keypair: kp("buyerAddr", G),
        side: Side::Buy,
        market: OrderMarket::Spot {
            id_desired: BTC_ID,
            id_for_sale: USD_ID,
        },
        limit: limit.map(sat),
        amount: sat(amount),
        max_collateral: None,
    }
}

fn sell_order(uuid: &str, amount: u64, limit: Option<u64>) -> OrderTerms {
    OrderTerms {
        uuid: uuid.into(),
        keypair: kp("sellerAddr", G2),
        side: Side::Sell,
        // the seller's order is stored mirrored: it desires the quote token and sells the base
        market: OrderMarket::Spot {
            id_desired: USD_ID,
            id_for_sale: BTC_ID,
        },
        limit: limit.map(sat),
        amount: sat(amount),
        max_collateral: None,
    }
}

fn buyer_book(amount: u64, limit: Option<u64>) -> OrderBook {
    let mut b = OrderBook::new();
    b.hold_key(kp("buyerAddr", G));
    b.add_order(buy_order("o1", amount, limit)).unwrap();
    b
}

// ---------------- order book / reservation ----------------

#[test]
fn trade_naming_a_key_the_wallet_does_not_hold_is_refused() {
    // PR #47 behaviour: the side refuses a trade naming a pubkey it does not hold.
    let mut b = OrderBook::new();
    b.hold_key(kp("buyerAddr", G3)); // holds a different pubkey for the same address
    let e = b
        .reserve_for(spot(100, 200).id(), &spot(100, 200), Role::Buyer)
        .unwrap_err();
    assert_eq!(e, Reject::KeyNotHeld);
    assert_eq!(b.reservation_count(), 0);
    // address held but with another pubkey: still refused
    let mut b = OrderBook::new();
    b.hold_key(kp("otherAddr", G));
    assert_eq!(
        b.reserve_for(spot(100, 200).id(), &spot(100, 200), Role::Buyer)
            .unwrap_err(),
        Reject::KeyNotHeld
    );
}

#[test]
fn trade_needs_a_fitting_open_order() {
    let info = spot(100, 200);
    // no orders at all
    let mut b = OrderBook::new();
    b.hold_key(kp("buyerAddr", G));
    assert_eq!(
        b.reserve_for(info.id(), &info, Role::Buyer).unwrap_err(),
        Reject::NoFittingOrder
    );
    // wrong side
    let mut b = OrderBook::new();
    b.hold_key(kp("buyerAddr", G));
    let mut o = buy_order("o1", 1_000, None);
    o.side = Side::Sell;
    b.add_order(o).unwrap();
    assert_eq!(
        b.reserve_for(info.id(), &info, Role::Buyer).unwrap_err(),
        Reject::NoFittingOrder
    );
    // wrong pair
    let mut b = OrderBook::new();
    b.hold_key(kp("buyerAddr", G));
    let mut o = buy_order("o1", 1_000, None);
    o.market = OrderMarket::Spot {
        id_desired: USD_ID,
        id_for_sale: BTC_ID,
    };
    b.add_order(o).unwrap();
    assert_eq!(
        b.reserve_for(info.id(), &info, Role::Buyer).unwrap_err(),
        Reject::NoFittingOrder
    );
    // wrong key pair on the order
    let mut b = OrderBook::new();
    b.hold_key(kp("buyerAddr", G));
    b.hold_key(kp("buyerAddr2", G3));
    let mut o = buy_order("o1", 1_000, None);
    o.keypair = kp("buyerAddr2", G3);
    b.add_order(o).unwrap();
    assert_eq!(
        b.reserve_for(info.id(), &info, Role::Buyer).unwrap_err(),
        Reject::NoFittingOrder
    );
    // fitting
    let mut b = buyer_book(1_000, None);
    assert_eq!(b.reserve_for(info.id(), &info, Role::Buyer).unwrap(), "o1");
}

#[test]
fn limit_price_is_respected_on_both_sides() {
    // trade price: 200 per 100 = 2.0 quote per base.
    let info = spot(100, 200);
    let two = 200_000_000u64;
    // buyer limit 2.0 accepts price 2.0, limit 1.99 refuses
    let mut b = buyer_book(1_000, Some(two));
    assert!(b.reserve_for(info.id(), &info, Role::Buyer).is_ok());
    let mut b = buyer_book(1_000, Some(two - 1));
    assert_eq!(
        b.reserve_for(info.id(), &info, Role::Buyer).unwrap_err(),
        Reject::PriceOutsideLimit
    );
    // seller limit: wants at least the limit
    let mut s = OrderBook::new();
    s.hold_key(kp("sellerAddr", G2));
    s.add_order(sell_order("s1", 1_000, Some(two + 1))).unwrap();
    assert_eq!(
        s.reserve_for(info.id(), &info, Role::Seller).unwrap_err(),
        Reject::PriceOutsideLimit
    );
    let mut s = OrderBook::new();
    s.hold_key(kp("sellerAddr", G2));
    s.add_order(sell_order("s1", 1_000, Some(two))).unwrap();
    assert_eq!(s.reserve_for(info.id(), &info, Role::Seller).unwrap(), "s1");
    // market order (no limit) accepts any price
    let mut s = OrderBook::new();
    s.hold_key(kp("sellerAddr", G2));
    s.add_order(sell_order("s1", 1_000, None)).unwrap();
    assert!(s
        .reserve_for(info.id(), &spot(1, 999_999), Role::Seller)
        .is_ok());
}

#[test]
fn reservation_never_exceeds_the_order_and_release_restores() {
    let mut b = buyer_book(1_000, None);
    let t1 = spot(400, 800);
    let mut t2 = spot(400, 800);
    t2.seller.session = sid("sockS2"); // distinct trade id, same order
    let mut t3 = spot(400, 800);
    t3.seller.session = sid("sockS3");
    b.reserve_for(t1.id(), &t1, Role::Buyer).unwrap();
    b.reserve_for(t2.id(), &t2, Role::Buyer).unwrap();
    assert_eq!(b.reserved_amount("o1"), Some(sat(800)));
    assert_eq!(b.available("o1"), Some(sat(200)));
    // two swaps cannot over-reserve
    assert_eq!(
        b.reserve_for(t3.id(), &t3, Role::Buyer).unwrap_err(),
        Reject::InsufficientUnreserved
    );
    assert!(b.invariant_holds());
    // release restores
    b.release(&t1.id()).unwrap();
    assert_eq!(b.reserved_amount("o1"), Some(sat(400)));
    assert_eq!(b.open_amount("o1"), Some(sat(1_000)));
    b.reserve_for(t3.id(), &t3, Role::Buyer).unwrap();
    assert!(b.invariant_holds());
    // double release / unknown trade
    assert_eq!(b.release(&t1.id()), Err(Reject::UnknownTrade));
    // duplicate reservation of the same trade
    assert_eq!(
        b.reserve_for(t2.id(), &t2, Role::Buyer).unwrap_err(),
        Reject::DuplicateTrade
    );
}

#[test]
fn settlement_consumes_the_order() {
    let mut b = buyer_book(1_000, None);
    let t = spot(1_000, 2_000);
    b.reserve_for(t.id(), &t, Role::Buyer).unwrap();
    assert_eq!(b.cancel_order("o1"), Err(Reject::OrderBusy));
    b.settle(&t.id()).unwrap();
    assert_eq!(b.open_amount("o1"), None); // filled completely -> closed
    assert!(b.invariant_holds());
    let mut b = buyer_book(1_000, None);
    let t = spot(300, 600);
    b.reserve_for(t.id(), &t, Role::Buyer).unwrap();
    b.settle(&t.id()).unwrap();
    assert_eq!(b.open_amount("o1"), Some(sat(700)));
    assert_eq!(b.reserved_amount("o1"), Some(sat(0)));
}

#[test]
fn self_trade_and_zero_amount_are_refused() {
    let mut b = buyer_book(1_000, None);
    b.hold_key(kp("sellerAddr", G2)); // we also hold the counterparty key
    assert_eq!(
        b.reserve_for(spot(10, 20).id(), &spot(10, 20), Role::Buyer)
            .unwrap_err(),
        Reject::SelfTrade
    );
    let mut b = buyer_book(1_000, None);
    assert_eq!(
        b.reserve_for(spot(0, 20).id(), &spot(0, 20), Role::Buyer)
            .unwrap_err(),
        Reject::InsufficientUnreserved
    );
    assert_eq!(b.add_order(buy_order("o2", 0, None)), Err(Reject::BadTerms));
    assert_eq!(
        b.add_order(buy_order("o1", 5, None)),
        Err(Reject::DuplicateOrder)
    );
}

#[test]
fn futures_trade_checks_contract_collateral_and_price() {
    let f = |price: u64, coll: u64| TradeInfo {
        kind: TradeKind::Futures(FuturesProps {
            amount: sat(5),
            contract_id: 3,
            price: sat(price),
            leverage: 2,
            collateral: sat(coll),
        }),
        ..spot(1, 1)
    };
    let order = |contract: u32| OrderTerms {
        uuid: "f1".into(),
        keypair: kp("buyerAddr", G),
        side: Side::Buy,
        market: OrderMarket::Futures {
            contract_id: contract,
        },
        limit: Some(sat(100)),
        amount: sat(10),
        max_collateral: Some(sat(50)),
    };
    let mk = |contract| {
        let mut b = OrderBook::new();
        b.hold_key(kp("buyerAddr", G));
        b.add_order(order(contract)).unwrap();
        b
    };
    assert!(mk(3)
        .reserve_for(f(100, 50).id(), &f(100, 50), Role::Buyer)
        .is_ok());
    assert_eq!(
        mk(4)
            .reserve_for(f(100, 50).id(), &f(100, 50), Role::Buyer)
            .unwrap_err(),
        Reject::NoFittingOrder
    );
    assert_eq!(
        mk(3)
            .reserve_for(f(101, 50).id(), &f(101, 50), Role::Buyer)
            .unwrap_err(),
        Reject::PriceOutsideLimit
    );
    assert_eq!(
        mk(3)
            .reserve_for(f(100, 51).id(), &f(100, 51), Role::Buyer)
            .unwrap_err(),
        Reject::PriceOutsideLimit
    );
}

// ---------------- state machine ----------------

fn pair(info: &TradeInfo) -> (Swap, Swap) {
    let id = info.id();
    (
        Swap::new(
            Role::Buyer,
            id,
            info.buyer.session.clone(),
            info.seller.session.clone(),
            0,
            SWAP_TIMEOUT_MS,
        ),
        Swap::new(
            Role::Seller,
            id,
            info.seller.session.clone(),
            info.buyer.session.clone(),
            0,
            SWAP_TIMEOUT_MS,
        ),
    )
}

fn channel() -> ChannelData {
    ChannelData {
        address: "MchannelAddr".into(),
        redeem_script: "5221aa21bb52ae".into(),
        script_pub_key: Some("a914cc87".into()),
    }
}

fn commit() -> CommitUtxo {
    CommitUtxo {
        txid: txid(4),
        vout: 1,
        amount: sat(3_600),
        script_pub_key: "a914cc87".into(),
        redeem_script: "5221aa21bb52ae".into(),
    }
}

fn payload_for(step: Step) -> Payload {
    match step {
        Step::MultisigOffer => Payload::MultisigOffer(channel()),
        Step::MultisigAck => Payload::Ack,
        Step::CommitUtxo => Payload::Commit(commit()),
        Step::TradePsbt => Payload::Psbt("70736274ff01".into()),
        Step::SignedPsbt => Payload::Psbt("70736274ff02".into()),
        Step::Final => Payload::Final(txid(9)),
    }
}

/// Drive the full happy path; returns the envelopes in order.
fn run_all(buyer: &mut Swap, seller: &mut Swap) -> Vec<Envelope> {
    let mut log = Vec::new();
    for n in 1..=6u8 {
        let step = Step::from_number(n).unwrap();
        let (tx, rx) = if step.sender() == Role::Seller {
            (&mut *seller, &mut *buyer)
        } else {
            (&mut *buyer, &mut *seller)
        };
        let env = tx.send(step, payload_for(step), 10).unwrap();
        assert_eq!(rx.receive(&env, 11).unwrap(), Kind::Step(step));
        log.push(env);
    }
    log
}

#[test]
fn full_swap_settles_only_after_all_six_steps() {
    let info = spot(100, 200);
    let (mut b, mut s) = pair(&info);
    assert_eq!(s.next_step(), Some(Step::MultisigOffer));
    for n in 1..=5u8 {
        let step = Step::from_number(n).unwrap();
        let (tx, rx) = if step.sender() == Role::Seller {
            (&mut s, &mut b)
        } else {
            (&mut b, &mut s)
        };
        let env = tx.send(step, payload_for(step), 10).unwrap();
        rx.receive(&env, 10).unwrap();
        assert!(
            b.is_active() && s.is_active(),
            "active before step 6 (after {n})"
        );
        assert_eq!(b.steps_done(), n);
    }
    let env = b.send(Step::Final, payload_for(Step::Final), 10).unwrap();
    assert_eq!(b.status(), &Status::Settled);
    s.receive(&env, 10).unwrap();
    assert_eq!(s.status(), &Status::Settled);
    assert_eq!(s.steps_done(), 6);
    assert_eq!(b.head(), s.head());
    // nothing after settlement
    assert_eq!(s.receive(&env, 10), Err(SwapError::Finished));
    assert_eq!(
        b.send(Step::Final, payload_for(Step::Final), 10),
        Err(SwapError::Finished)
    );
    assert_eq!(b.terminate("late"), Err(SwapError::Finished));
}

#[test]
fn repaired_steps_must_arrive_in_order_and_only_once() {
    let info = spot(100, 200);
    let (mut b, mut s) = pair(&info);
    let e1 = s
        .send(Step::MultisigOffer, payload_for(Step::MultisigOffer), 1)
        .unwrap();
    // replay of step 1 after acceptance
    b.receive(&e1, 1).unwrap();
    assert_eq!(
        b.receive(&e1, 1),
        Err(SwapError::OutOfOrder {
            expected: Step::MultisigAck,
            got: Step::MultisigOffer
        })
    );
}

#[test]
fn repaired_skipped_and_foreign_sender_steps_are_rejected() {
    let info = spot(100, 200);
    let (mut b, mut s) = pair(&info);
    // seller tries to jump straight to step 3
    assert_eq!(
        s.send(Step::CommitUtxo, payload_for(Step::CommitUtxo), 1),
        Err(SwapError::NotOurTurn)
    );
    // buyer cannot send the seller's step 1
    assert_eq!(
        b.send(Step::MultisigOffer, payload_for(Step::MultisigOffer), 1),
        Err(SwapError::NotOurTurn)
    );
    // forged step 3 from the peer while step 1 is expected
    let e1 = s
        .send(Step::MultisigOffer, payload_for(Step::MultisigOffer), 1)
        .unwrap();
    let mut forged = e1.clone();
    forged.kind = Kind::Step(Step::CommitUtxo);
    forged.payload = payload_for(Step::CommitUtxo);
    assert!(matches!(
        b.receive(&forged, 1),
        Err(SwapError::OutOfOrder { .. })
    ));
    // genuine one still works afterwards (a rejected message changes nothing)
    b.receive(&e1, 1).unwrap();
}

#[test]
fn messages_are_bound_to_trade_peer_and_previous_step() {
    let info = spot(100, 200);
    let (mut b, mut s) = pair(&info);
    let e1 = s
        .send(Step::MultisigOffer, payload_for(Step::MultisigOffer), 1)
        .unwrap();
    // other trade id (e.g. same peers but different amounts)
    let other = spot(101, 200).id();
    let mut wrong_trade = e1.clone();
    wrong_trade.trade_id = other;
    assert_eq!(b.receive(&wrong_trade, 1), Err(SwapError::WrongTrade));
    // spoofed session
    let mut wrong_peer = e1.clone();
    wrong_peer.from = sid("attacker");
    assert_eq!(b.receive(&wrong_peer, 1), Err(SwapError::WrongPeer));
    // stale / wrong previous digest
    let mut bad_prev = e1.clone();
    bad_prev.prev = [0u8; 32];
    assert_eq!(b.receive(&bad_prev, 1), Err(SwapError::BadPrev));
    // rejected messages did not advance anything
    assert_eq!(b.steps_done(), 0);
    b.receive(&e1, 1).unwrap();
    // step 2 envelope from the buyer, then a step-3 built on a different transcript is refused
    let e2 = b.send(Step::MultisigAck, Payload::Ack, 2).unwrap();
    s.receive(&e2, 2).unwrap();
    let mut e3 = s
        .send(Step::CommitUtxo, payload_for(Step::CommitUtxo), 3)
        .unwrap();
    e3.prev = e1.prev; // splice: claims to follow step 0
    assert_eq!(b.receive(&e3, 3), Err(SwapError::BadPrev));
}

#[test]
fn payload_shape_and_bounds_are_enforced() {
    let info = spot(100, 200);
    let (mut b, mut s) = pair(&info);
    // wrong payload type for the step
    assert!(matches!(
        s.send(Step::MultisigOffer, Payload::Ack, 1),
        Err(SwapError::BadPayload(_))
    ));
    // non-hex / oversized psbt
    let e1 = s
        .send(Step::MultisigOffer, payload_for(Step::MultisigOffer), 1)
        .unwrap();
    b.receive(&e1, 1).unwrap();
    let e2 = b.send(Step::MultisigAck, Payload::Ack, 1).unwrap();
    s.receive(&e2, 1).unwrap();
    let e3 = s
        .send(Step::CommitUtxo, payload_for(Step::CommitUtxo), 1)
        .unwrap();
    b.receive(&e3, 1).unwrap();
    assert!(matches!(
        b.send(Step::TradePsbt, Payload::Psbt("zz".into()), 1),
        Err(SwapError::BadPayload(_))
    ));
    let huge = "ab".repeat(MAX_PSBT_CHARS);
    assert!(matches!(
        b.send(Step::TradePsbt, Payload::Psbt(huge), 1),
        Err(SwapError::BadPayload(_))
    ));
    // bad txid in the commit
    let mut bad = commit();
    bad.txid = "12".into();
    let (mut b2, mut s2) = pair(&info);
    let e1 = s2
        .send(Step::MultisigOffer, payload_for(Step::MultisigOffer), 1)
        .unwrap();
    b2.receive(&e1, 1).unwrap();
    let e2 = b2.send(Step::MultisigAck, Payload::Ack, 1).unwrap();
    s2.receive(&e2, 1).unwrap();
    assert!(matches!(
        s2.send(Step::CommitUtxo, Payload::Commit(bad), 1),
        Err(SwapError::BadPayload(_))
    ));
}

#[test]
fn terminate_ends_the_swap_and_nothing_follows() {
    let info = spot(100, 200);
    let (mut b, mut s) = pair(&info);
    let e1 = s
        .send(Step::MultisigOffer, payload_for(Step::MultisigOffer), 1)
        .unwrap();
    b.receive(&e1, 1).unwrap();
    let t = b.terminate("user cancelled").unwrap();
    assert!(matches!(
        b.status(),
        Status::Terminated { by_peer: false, .. }
    ));
    assert_eq!(s.receive(&t, 2).unwrap(), Kind::Terminate);
    assert!(matches!(
        s.status(),
        Status::Terminated { by_peer: true, .. }
    ));
    // after terminate: no more steps in either direction
    assert_eq!(
        b.send(Step::MultisigAck, Payload::Ack, 3),
        Err(SwapError::Finished)
    );
    assert_eq!(
        s.send(Step::CommitUtxo, payload_for(Step::CommitUtxo), 3),
        Err(SwapError::Finished)
    );
    assert_eq!(s.receive(&e1, 3), Err(SwapError::Finished));
    // a terminate from the wrong session / other trade is ignored
    let (mut b2, mut s2) = pair(&info);
    let mut forged = s2.terminate("x").unwrap();
    forged.from = sid("attacker");
    assert_eq!(b2.receive(&forged, 1), Err(SwapError::WrongPeer));
    forged.from = info.seller.session.clone();
    forged.trade_id = spot(5, 5).id();
    assert_eq!(b2.receive(&forged, 1), Err(SwapError::WrongTrade));
    assert!(b2.is_active());
}

#[test]
fn timeout_is_final() {
    let info = spot(100, 200);
    let (mut b, mut s) = pair(&info);
    let e1 = s
        .send(
            Step::MultisigOffer,
            payload_for(Step::MultisigOffer),
            59_999,
        )
        .unwrap();
    assert_eq!(
        b.receive(&e1, 59_999).unwrap(),
        Kind::Step(Step::MultisigOffer)
    );
    assert!(!b.clone().tick(SWAP_TIMEOUT_MS));
    let e2 = b.send(Step::MultisigAck, Payload::Ack, 60_000);
    assert_eq!(e2, Err(SwapError::TimedOut));
    assert_eq!(b.status(), &Status::TimedOut);
    assert_eq!(s.receive(&e1, 60_001), Err(SwapError::TimedOut));
    // after timeout every input is "finished"
    assert_eq!(b.receive(&e1, 60_002), Err(SwapError::Finished));
    assert_eq!(b.terminate("late"), Err(SwapError::Finished));
}

#[test]
fn trade_id_depends_on_every_term() {
    let base = spot(100, 200);
    let id = base.id();
    assert_eq!(id, spot(100, 200).id());
    assert_ne!(id, spot(100, 201).id());
    assert_ne!(id, spot(101, 200).id());
    let mut t = spot(100, 200);
    t.seller.keypair.pubkey = G3.into();
    assert_ne!(id, t.id());
    let mut t = spot(100, 200);
    t.buyer.session = sid("sockB2");
    assert_ne!(id, t.id());
}

#[test]
fn event_names_match_legacy() {
    let names: Vec<String> = (1..=6)
        .map(|n| Step::from_number(n).unwrap().event_name())
        .collect();
    assert_eq!(
        names,
        [
            "SELLER:STEP1",
            "BUYER:STEP2",
            "SELLER:STEP3",
            "BUYER:STEP4",
            "SELLER:STEP5",
            "BUYER:STEP6"
        ]
    );
}

#[test]
fn transcript_vector_is_stable() {
    // The Lean model fixes the same ordering vector (TlWalletService/Swap.lean).
    let info = spot(100, 200);
    let (mut b, mut s) = pair(&info);
    let log = run_all(&mut b, &mut s);
    let steps: Vec<u8> = log
        .iter()
        .map(|e| match e.kind {
            Kind::Step(s) => s.number(),
            Kind::Terminate => 0,
        })
        .collect();
    assert_eq!(steps, vec![1, 2, 3, 4, 5, 6]);
    let senders: Vec<&str> = log.iter().map(|e| e.from.as_str()).collect();
    assert_eq!(
        senders,
        ["sockS", "sockB", "sockS", "sockB", "sockS", "sockB"]
    );
}

// ---------------- payload checks ----------------

#[test]
fn repaired_buyer_uses_its_own_channel_address() {
    let local = channel();
    // seller offers its own address with the right redeem script
    let mut offered = channel();
    offered.address = "MsellerOwnAddr".into();
    assert_eq!(
        check_multisig_offer(&local, &offered),
        Err(CheckError::AddressMismatch)
    );
    let mut offered = channel();
    offered.redeem_script = "5221ff52ae".into();
    assert_eq!(
        check_multisig_offer(&local, &offered),
        Err(CheckError::RedeemScriptMismatch)
    );
    let mut offered = channel();
    offered.script_pub_key = Some("a914dd".into());
    assert_eq!(
        check_multisig_offer(&local, &offered),
        Err(CheckError::ScriptPubKeyMismatch)
    );
    assert_eq!(check_multisig_offer(&local, &channel()).unwrap(), local);
}

#[test]
fn commit_utxo_must_pay_the_channel() {
    let ch = channel();
    assert_eq!(check_commit_utxo(&commit(), &ch), Ok(()));
    let mut c = commit();
    c.script_pub_key = "0014aa".into();
    assert_eq!(
        check_commit_utxo(&c, &ch),
        Err(CheckError::CommitNotToChannel)
    );
    let mut c = commit();
    c.amount = Amount::ZERO;
    assert_eq!(
        check_commit_utxo(&c, &ch),
        Err(CheckError::CommitZeroAmount)
    );
    let mut unknown = ch.clone();
    unknown.script_pub_key = None;
    assert_eq!(
        check_commit_utxo(&commit(), &unknown),
        Err(CheckError::CommitNotToChannel)
    );
}

// ---------------- manager ----------------

fn manager() -> SwapManager {
    SwapManager::new(buyer_book(1_000, None))
}

#[test]
fn manager_settles_and_consumes_the_reservation() {
    let info = spot(400, 800);
    let mut m = manager();
    let id = m.start_trade(&info, Role::Buyer, 0).unwrap();
    assert_eq!(m.book.reserved_amount("o1"), Some(sat(400)));
    let mut seller = Swap::new(
        Role::Seller,
        id,
        info.seller.session.clone(),
        info.buyer.session.clone(),
        0,
        SWAP_TIMEOUT_MS,
    );
    for n in 1..=6u8 {
        let step = Step::from_number(n).unwrap();
        if step.sender() == Role::Seller {
            let env = seller.send(step, payload_for(step), 5).unwrap();
            m.receive(&env, 5).unwrap();
        } else {
            let env = m.send(&id, step, payload_for(step), 5).unwrap();
            seller.receive(&env, 5).unwrap();
        }
    }
    assert_eq!(m.outcome(&id), Some(Outcome::Settled));
    assert_eq!(m.active_count(), 0);
    assert_eq!(m.book.open_amount("o1"), Some(sat(600)));
    assert_eq!(m.book.reserved_amount("o1"), Some(sat(0)));
    // replay of a settled trade is not restarted
    assert!(m.start_trade(&info, Role::Buyer, 6).is_err());
}

#[test]
fn manager_releases_on_terminate_and_on_timeout() {
    let mut m = manager();
    let a = spot(400, 800);
    let id = m.start_trade(&a, Role::Buyer, 0).unwrap();
    m.terminate(&id, "no thanks").unwrap();
    assert_eq!(m.outcome(&id), Some(Outcome::Aborted));
    assert_eq!(m.book.reserved_amount("o1"), Some(sat(0)));
    assert_eq!(m.book.open_amount("o1"), Some(sat(1_000)));

    let mut b = spot(400, 800);
    b.seller.session = sid("sockS2");
    let id2 = m.start_trade(&b, Role::Buyer, 100).unwrap();
    m.tick(100 + SWAP_TIMEOUT_MS - 1);
    assert_eq!(m.active_count(), 1);
    m.tick(100 + SWAP_TIMEOUT_MS);
    assert_eq!(m.outcome(&id2), Some(Outcome::TimedOut));
    assert_eq!(m.book.reserved_amount("o1"), Some(sat(0)));
    assert!(m.book.invariant_holds());
}

#[test]
fn manager_refuses_unfunded_and_unknown_trades() {
    let mut m = manager();
    // over-reserving order: 3 x 400 against 1000
    let mut ids = Vec::new();
    for i in 0..3 {
        let mut t = spot(400, 800);
        t.seller.session = sid(&format!("sockS{i}"));
        ids.push(m.start_trade(&t, Role::Buyer, 0));
    }
    assert!(ids[0].is_ok() && ids[1].is_ok());
    assert_eq!(
        ids[2],
        Err(ManagerError::Rejected(Reject::InsufficientUnreserved))
    );
    // messages for an unknown trade
    let t = spot(1, 2);
    let (_, mut s) = pair(&t);
    let env = s
        .send(Step::MultisigOffer, payload_for(Step::MultisigOffer), 0)
        .unwrap();
    assert_eq!(m.receive(&env, 0), Err(ManagerError::UnknownTrade));
    // same session on both sides
    let mut same = spot(10, 20);
    same.seller.session = same.buyer.session.clone();
    assert_eq!(
        m.start_trade(&same, Role::Buyer, 0),
        Err(ManagerError::SameSession)
    );
    // unheld key
    let mut other = spot(10, 20);
    other.buyer.keypair.pubkey = G3.into();
    assert_eq!(
        m.start_trade(&other, Role::Buyer, 0),
        Err(ManagerError::Rejected(Reject::KeyNotHeld))
    );
}

#[test]
fn manager_bounds_concurrent_swaps() {
    let mut book = OrderBook::new();
    book.hold_key(kp("buyerAddr", G));
    book.add_order(buy_order("o1", 1_000_000, None)).unwrap();
    let mut m = SwapManager::new(book);
    let mut last = Ok(spot(1, 1).id());
    for i in 0..(MAX_ACTIVE_SWAPS + 1) {
        let mut t = spot(10, 20);
        t.seller.session = sid(&format!("s{i}"));
        last = m.start_trade(&t, Role::Buyer, 0);
    }
    assert_eq!(last, Err(ManagerError::TooManySwaps));
    assert_eq!(m.active_count(), MAX_ACTIVE_SWAPS);
}
