# tl-wallet-service

Rust extraction of the TradeLayer desktop wallet's **backend contracts and non-UI trading logic**.
The Angular UI stays as it is; this crate is the service boundary it will talk to during migration.
Nothing here contacts a node, signs with a real key, or moves funds: every I/O edge is a trait with
an in-memory double (`src/mem.rs`).

* Baseline: `tradelayer-wallet` master `7ddba36ca06538510e6460df0ddece8a71fcb547`, branch `feat/rust-port`.
* Toolchain: Rust 1.90.0 (`rust-toolchain.toml`), Lean 4 `v4.34.1`, committed `Cargo.lock`.
* Licence: ISC (as the repository `package.json`).

## Inspected legacy sources

`packages/wallet-server/src/{index,fastify-server}.ts`, `routes/{keys,main}.route.ts`,
`services/{tx-builder,node,socket,ob-sockets}.service.ts`, `utils/{crypto,common,networks}.util.ts`;
`packages/wallet-fe/src/app/utils/swapper/{common,swap,seller,buyer}.ts`;
`packages/wallet-fe/src/app/@core/services/{swap,txs,balance,rpc,socket}.service.ts`,
`spot-services/*`, `futures-services/*`, `@core/apis/*`; `builder/electron-builder.ts` (how the
server is started and which origin the renderer has). Pinned oracles: `tx-builder.service.ts` blob
`2b11ba8ed36dce681cc11b5777fc2041efb62f21`; `spot-buy-sell-card.component.ts`
`8084a278e0e587d51cae99f5effbde043db6b1c4`, `futures-buy-sell-card.component.ts`
`ad90f24e31051e353c79a2799a0a266e50de2bdc`, `utils/common.util.ts` (`safeNumber`)
`5581baadb1febe58125636eec9a7f5d578773e77`.

Front-end client logic (second pass): `@pages/{spot,futures}-page/.../*-buy-sell-card.component.ts`,
`@pages/tx-builder-page/{build,sign,send,decode}-tab`, `@shared/dialogs/{tx-builder,withdraw,new-multisig}`,
`@core/services/{attestation,node-reward,rpc,auth}.service.ts`,
`{spot,futures}-services/{futures-positions,spot-channels,futures-channels}.service.ts`.

## What was ported

| Legacy | Rust | Notes |
|---|---|---|
| `fastify-server.ts`, `routes/*.ts` (12 routes) | `service::WalletService::handle` | route table, request validation, legacy `{data}`/`{error}` shapes; node, keys, signer, config store, relayer behind traits |
| (none: no auth) | `gate::Gate` | per-session token, loopback peer, Host and Origin allowlists, RPC method allowlist, CORS echo only for allowlisted origin |
| `services/tx-builder.service.ts` (`buildTx`, `buildLTCInstatTx`, `getEnoughInputs[2]`) | `txbuilder::{plan_payment, plan_instant_trade}` + `service` orchestration | integer base units (1e-8), fee 60 000 per input, conservation checked |
| `utils/crypto.util.ts` `buildPsbt` | `psbt::build_psbt` | on the `bitcoin` crate; node `scriptPubKey` authoritative |
| `utils/crypto.util.ts` sign paths | `psbt::{guard_sign, guard_psbt}` + `SignBackend` trait | signing itself stays outside (see gaps) |
| `services/node.service.ts` | `nodecfg` | `litecoin.conf` render/parse, launch argv, endpoint/URL validation |
| `socket.service.ts`, `ob-sockets.service.ts` | `bridge::Bridge` | policy only (who may connect, which events pass) |
| `utils/swapper/{buyer,seller,swap,common}.ts` | `swap::{machine, types, checks}` | pure sans-IO state machine, six steps + terminate + 60 s timeout |
| `swap.service.ts` + PR #47 behaviour | `swap::{order, manager}` | key must be held, fitting open order, amount reservation |
| `orderbook` / `balance` services math | `market` | depth levels, last price, history side, confirmed/unconfirmed balance |
| `spot-buy-sell-card` / `futures-buy-sell-card` (`handleBuySell`, `getMaxAmount`, `getFees`, `getInOrderAmount`, `getTotal`, `getButtonDisabled`) | `orderform::{build_order, max_amount, fee_estimate, reserved_in_orders, total_display, button_disabled, form_valid}` | order construction on checked base units; payload via `OrderRequest::to_json` in the legacy `new-order` shape |
| tx-builder page `build-tab`; dialog `tx-types/{send-ltc,send-token,send-vesting,send-activation}`; `withdraw`; sign/decode/send tabs | `txforms::{payload_call, send_request, withdraw_request, withdraw_max, AddressCheck, parse_validateaddress, check_raw_tx, vins_from_decoded, detail_complete}` | `tl_createpayload_*` parameters, `tradeData` objects, address-check gating, withdraw limits |
| `new-multisig` dialog and the sign tab's key stepper | `txforms::{Stepper, MultisigForm}` | 2..=7 keys, `nRequired` in 2..=n, one HOT key, `addmultisigaddress` call |
| `attestation`, `futures-positions`, `{spot,futures}-channels`, `node-reward`, `rpc` (sync), `auth` (address list, active key) services | `clientstate::{AttestationBook, parse_position, parse_commits, claim_round, update_registration, SyncState, WalletKeys, active_key, fetch_wallet_addresses}` | state transitions and RPC-result parsing; RPC calls and toasts are closures/return values |

## Compatibility table

Legend: **preserved** contract, **repaired** defect (regression test named), **versioned** protocol
change, **open** question.

| Item | Status | Legacy location | Rust behaviour / test |
|---|---|---|---|
| Route names, bodies, `{data}`/`{error}` shapes, 200/500 | preserved | `routes/*.ts` | `tests/service.rs` |
| Fee 0.3 x 0.002 coin per selected input; largest-first selection; supplied inputs first; minimum output; "Minimum amount is" | preserved | `tx-builder.service.ts:208-224` | `tests/txbuilder.rs`, `tests/legacy_parity.rs` (against the pinned functions) |
| Default RPC ports 8332 / 18332 (Bitcoin's, not Litecoin's) | preserved, **open** | `node.service.ts` | `rpc_endpoint_defaults_are_the_legacy_ports` |
| No authentication on the local service | **repaired** | `fastify-server.ts:33`, all routes | `repaired_every_route_requires_the_session_token`, `tests/gate.rs` |
| `rpc-call` forwards any method (`dumpprivkey`, ...) | **repaired** | `main.route.ts:13` | `repaired_rpc_proxy_blocks_unlisted_methods...`, `repaired_rpc_proxy_forwards_only_allowlisted_methods` |
| socket.io `cors: { origin: "*" }`; newest connection replaces the wallet socket | **repaired** | `socket.service.ts:15,25` | `repaired_socket_handshake_is_gated`, `repaired_cors_wildcard_origin_and_foreign_origins` |
| No Host check (DNS rebinding), remote peers | **repaired** | `fastify-server.ts` | `repaired_dns_rebinding_host_and_remote_peers` |
| `set-api-url` / `ob-sockets-connect` accept any URL | **repaired** | `main.route.ts:114`, `socket.service.ts:28` | `repaired_set_api_url_is_validated`, `endpoint_validation` |
| `litecoin.conf` value injection (newline -> extra node options) | **repaired** | `node.service.ts:58` | `repaired_config_injection_is_rejected` |
| Conf values containing `=` truncated; `rpchost` accepted from any host | **repaired** | `node.service.ts:119,137` | `start_node_reads_conf_keeping_equals_signs_in_values`, `start_node_error_paths` |
| Node command built as a quoted shell string | **repaired** | `node.service.ts:110-111,156` | `launch_args_match_legacy_order_and_have_no_shell` |
| Payload txs charge the fee twice | **repaired** | `tx-builder.service.ts:168-172` | `repaired_payload_tx_does_not_charge_fee_twice` |
| Negative change silently dropped (under-funded fee) | **repaired** | `:170-180` | `repaired_negative_change_is_an_error_not_a_silent_drop` |
| Amount below `min + fee` clamped up, fee under-paid | **repaired** | `:168-169` | `repaired_amount_below_fee_is_not_clamped` |
| Value check `inputsSum < fee + to + change` can never fire | **repaired** | `:174` | exact `Plan::check_conservation`; Lean `planPayment_conserves` |
| Duplicate outpoints (`inputs` + `listunspent`) double counted | **repaired** | `:102,156` | `repaired_duplicate_outpoints_counted_once` |
| Fee-aware selection priced one input too many | **repaired** | `:211-212` | `repaired_no_extra_input_selected`, `sender_pays_selection_vs_getenoughinputs2` |
| Mandatory commit UTXOs dropped once the target is covered | **repaired** | `:208-214` | `repaired_commit_utxos_are_mandatory`; Lean `planInstant_keeps_commit_utxos` |
| `from == to` collapses two outputs into one object key | **repaired** | `:179-180` | `repaired_equal_from_and_to_addresses_merge` |
| Signing trusts caller input amounts and any fee | **repaired** | `crypto.util.ts:86-129`, `main.route.ts:91-110` | `repaired_sign_guard_binds_amounts_and_fee`, `sign_tx_reaches_the_signer_only_after_the_guard_passes` |
| Seller signs any PSBT the buyer sends | **repaired** | `seller.ts:135` | `repaired_seller_checks_the_trade_psbt_before_signing` (`psbt::check_trade_psbt`) |
| Buyer commits to the seller-supplied channel address | **repaired** | `buyer.ts:52-53,93,149` | `repaired_buyer_uses_its_own_channel_address`, `commit_utxo_must_pay_the_channel` |
| Steps accepted out of order, replayed, or after finish; only a self-asserted `socketId` | **repaired** | `seller.ts`/`buyer.ts` `switch` | `tests/swap.rs`; Lean `receive_in_order`, `finished_is_final` |
| Whole-trade timer never cleared (TERMINATE sent after success) | **repaired** | `swap.ts:23` | `timeout_is_final`, `manager_releases_on_terminate_and_on_timeout` |
| Trade for a key the wallet does not hold / no fitting open order / over-reservation | **repaired** (PR #47 behaviour) | `swap.service.ts` | `trade_naming_a_key_the_wallet_does_not_hold_is_refused`, `trade_needs_a_fitting_open_order`, `limit_price_is_respected_on_both_sides`, `reservation_never_exceeds...` |
| Every request carries the session token (`X-TL-Session`); socket handshake carries it too | **versioned** | n/a | the Angular HTTP interceptor and socket client must send it; Electron main generates the token and passes it to both sides |
| Every swap envelope carries `trade_id`, sender session and transcript digest of the previous step | **versioned** | n/a | `TradeInfo::id` derives the id from the full trade terms on both sides, so the orderbook server needs no change; the peer wire format still does |
| Depth levels: grouping key is the raw price, not the rounded first price | **repaired** (minor) | `*-orderbook.service.ts` | `aggregate_groups_by_third_decimal...` |
| JS rounding (`toFixed`) vs decimal half-up on integers; price `x/0` | **versioned** | services | `spot_trade_price_rounding_and_fallbacks` |
| Meaning of an order `amount` / `limit` for spot SELL orders | **open** | `*-orderbook.service.ts` | assumed: base-asset quantity, quote-per-base limit x 1e8 (`order.rs` header); owned by `tl-orderbook-server` |
| Whether legacy `buildPsbt` (witness-program `witnessUtxo.script` + `redeemScript`) signs P2SH-wrapped inputs | **open** | `crypto.util.ts:136-170` | Rust uses the node's `scriptPubKey` and verifies it commits to the program; legacy not executed |
| Order handler accepted any amount; only the template disabled the button above `getMaxAmount` | **repaired** | `spot-buy-sell-card.component.ts:138-190` (`handleBuySell`), `:124-133` | `repaired_handler_enforces_the_balance_the_template_only_hinted_at`; Lean `accepts_within_available` |
| `getMaxAmount` = `available / price` rounded to nearest 1e-6: the maximum can cost more than the balance (0.2 / 0.3 -> 0.666667) | **repaired** | `spot-buy-sell-card.component.ts:132-133`, `futures-buy-sell-card.component.ts:116` | `repaired_max_amount_never_costs_more_than_the_balance`; Lean `maxBuy_affordable`, `maxBuy_maximal` (cost is rounded up, maximum down) |
| LTC maximum used the fee of the amount already typed (hence the "tricky update" double call in `fillMax`); no fixed point | **repaired** | `spot:93-96,124-133` | `repaired_ltc_maximum_pays_the_fee_of_the_maximum_not_of_the_typed_amount`; Lean `fitsLtc_downward` (monotone search) |
| In-order reservation `amount * price` for every order; a SELL reserves the base `amount` | **repaired** | `spot:302-313`, `futures:224-229` | `repaired_sell_order_reserves_the_base_amount`; Lean `sell_commits_amount` |
| Fee estimate funded `amount * price` LTC for a SELL of LTC; the futures card did so for a token collateral | **repaired** | `spot:326-345`, `futures:243-257` | `repaired_fee_estimate_sell_of_ltc_...`, `repaired_futures_fee_funds_tokens_not_ltc` |
| Market order with no current price passes the `(!price && isLimit)` test; `available / 0 = Infinity` enables the button | **repaired** | `spot:157`, `futures:142` | `repaired_market_order_without_a_price_has_no_maximum` |
| Futures SELL maximum is the collateral balance in contracts, ignoring the price | **repaired** | `futures:116` | `repaired_futures_sell_maximum_is_priced` (margin `amount * price` on both sides, leverage 1) |
| Values with more than 8 decimals / exponents reach the order | **repaired** | form controls | `control_parsing_refuses_exponents_and_extra_decimals` |
| Fee estimate: phantom `0.000036` first entry in the LTC input list and the `len + 1` fee pricing (upper bound; the repaired `txbuilder` selects fewer inputs) | preserved, **open** | `spot:341-343`, `futures:251` | `fee_estimate_matches_legacy_get_fees_where_preserved` (24 side/case pairs against the pinned method); Lean `feeLtc_bound` |
| Futures wire key is the typo `levarage` (the book type declares `leverage`) | preserved, **open** | `futures:137,157`, `futures-orderbook.service.ts:32` | `futures_order_keeps_the_levarage_wire_name` |
| Order amount is the base quantity, price is quote per base; futures margin `amount * price` | **open** | cards | stated in `orderform.rs`; owned by `tl-orderbook-server` |
| Property id 0 is not tradable (JS truthiness) | preserved, **open** | `handleBuySell`, `withdraw()` | `order_error_paths_and_their_order`, `withdraw_ltc_and_token_requests` |
| `tl_createpayload_*` ints via `parseFloat` (NaN -> null, `1.5`, negatives), amounts via `Number.toString` (`1e-7`), zero/negative amounts pass `required` | **repaired** | `tx-builder-page/build-tab:95-96` | `repaired_amount_strings_have_no_exponent_and_ids_are_strict_integers` |
| Send dialogs build with an unchecked recipient (`isAddressValid === null`); missing `isvalid` leaves `undefined`; `error.message` read on an empty `data` throws | **repaired** | `tx-types/*/*.tx-type.component.ts:39,50-60` | `address_check_states_and_validateaddress_parsing`, `repaired_send_requires_a_positive_recipient_check`; Lean `only_valid_builds`, `edited_blocks_build` |
| Withdraw dialog never validates the recipient (`validateAddress` body commented out); amount sent as `toString()`; LTC maximum is all confirmed (a plain send takes the fee from the amount: preserved) | **repaired** / preserved | `withdraw.component.ts:50,94-105,121` | `repaired_withdraw_recipient_is_validated_and_the_amount_has_no_exponent`; Lean `withdraw_needs_validated_recipient`, `withdraw_within_bounds` |
| Multisig: type change keeps the old pubkey (HARDWARE/SERVER never get a key); pubkeys unchecked and may repeat | **repaired** | `new-multisig.component.ts:72,114,117-126` | `repaired_multisig_type_change_clears_the_old_key`, `repaired_multisig_pubkeys_are_validated_and_distinct`; Lean `*_inv` (stepper) |
| Sign tab maps a coinbase input to `{txid: undefined}` | **repaired** | `tabs/sign/sign-tab.component.ts:129`, `tx-builder-page/sign-tab:90` | `repaired_coinbase_input_is_not_a_signable_vin` |
| Dialog `tx-types/*` call `BuilderService.build`, a service that does not exist in the pinned snapshot (the dialog cannot compile) | **open** | `tx-types/*` | `send_request` produces the `tradeData` they would send; the receiving contract is undefined |
| `checkWinners` recurses on every error (unbounded) and after every claim (re-claims while still winner) | **repaired** | `node-reward.service.ts:95-118` | `repaired_claim_round_claims_each_winner_once`, `repaired_claim_round_retries_...` |
| `getAddressesFromWallet` recurses without bound after `createwallet` | **repaired** | `auth.service.ts:149-182` | `repaired_create_wallet_retry_is_bounded` |
| Attestation error toast reads `error.messagokee` (`undefined`) | **repaired** | `attestation.service.ts:50` | `repaired_attestation_error_text_uses_the_real_error` |
| Position / commit values via `parseFloat` (NaN into UI state) | **repaired** | `futures-positions.service.ts:66`, `*-channels.service.ts:48-49` | `repaired_malformed_position_is_an_error_not_nan`, `commits_parse_and_reject_malformed_entries` |
| `isSynced` returned a number/boolean mix | **repaired** (minor) | `rpc.service.ts:74-76` | `sync_state_follows_blocks_and_core_errors` |
| `tl_check_kyc` key `result: ` (trailing space), `tl_listnodereward_addresses` key `address:`, payloads `007900`/`007A00` | preserved | services | `kyc_result_key_has_a_trailing_space`, `registered_list_keeps_the_colon_key_and_pendings` |
| Dust threshold for change outputs | **open** | `tx-builder.service.ts` | change is emitted when > 0, as legacy |
| OP_RETURN payload tail is the buyer's `tl_getinfo` block + 100 | **open** | `buyer.ts:68` | `check_trade_psbt` can only check a payload prefix |

## Commands

```sh
cd rust/tl-wallet-service
cargo test --locked --offline
cargo clippy --locked --offline --all-targets -- -D warnings
cargo fmt --all -- --check
node scripts/compare-legacy.cjs | diff - scripts/legacy-vectors.json   # needs the repo checkout; --write refreshes
node scripts/compare-orderform.cjs | diff - scripts/legacy-orderform.json   # buy/sell card methods, pinned blobs
cd lean && lake build && lake env lean AxiomCheck.lean                  # no sorryAx
```

CI: `.github/workflows/rust-tl-wallet-service.yml` (not run until the branch is pushed).

## Dependencies

* `bitcoin 0.32` (`default-features = false, features = ["std"]`; resolves to secp256k1 0.29 and
  `bitcoin_hashes`): transaction/PSBT consensus encoding and SHA-256. Cryptography is not
  reimplemented. Litecoin shares the consensus serialization; no address encoding is used.
* `serde_json =1.0.145`: request bodies and RPC params/results (a general JSON parser is out of
  scope per the charter). Everything else is `std`.

## Lean 4 (`lean/`, core only, no Mathlib, no `sorry`/`axiom`)

| Module | Models | Theorems |
|---|---|---|
| `Gate` | `gate::Gate::{check, check_rpc, cors_allow_origin}` | `serve_iff`, `no_token_no_service`, `wrong_token_no_service`, `foreign_origin_no_service`, `remote_peer_no_service`, `bad_host_no_service`, `method_not_allowed_no_service`, `serve_implies_token`, `cors_only_allowlisted` |
| `Swap` | `swap::machine::Swap::{receive, send, terminate, tick}` | `reachable_inv`, `settled_needs_all_steps`, `receive_in_order`, `receive_bound_to_trade_and_peer`, `receive_bound_to_previous`, `receive_sender_is_peer_role`, `finished_is_final`, `no_step_after_timeout`, `terminate_then_final`, `sender_alternates` |
| `Order` | `OrderBook::{reserve_for, release, settle}` | `reserve_within_order`, `reserve_preserves_inv`, `two_swaps_cannot_overreserve`, `release_restores`, `release_preserves_inv`, `settle_conserves`, `settle_preserves_inv` |
| `TxBuilder` | `txbuilder::{select, plan_payment, plan_instant_trade}` | `selectAux_eq_take`, `planPayment_conserves`, `planPayment_fee_exact`, `planPayment_fee_bound`, `planPayment_nonempty`, `planPayment_to_ge_min`, `planPayment_inputs_prefix`, `planInstant_conserves`, `finishInstant_buyer_min`, `planInstant_keeps_commit_utxos` |
| `OrderForm` | `orderform::{cost, max_for_budget, commitment, fee_estimate, fits, build_order}` | `cost_ge`, `cost_mono`, `maxBuy_affordable`, `maxBuy_maximal`, `sell_commits_amount`, `accepts_within_available`, `acceptsLtc_within_available`, `accepts_positive`, `max_buy_accepted`, `max_buy_plus_one_refused`, `countInputs_ge`, `countInputs_le`, `countInputs_stopped`, `countInputs_mono`, `feeLtc_bound`, `feeLtc_mono`, `commitment_mono`, `fitsLtc_downward` |
| `Forms` | `txforms::{Stepper, AddressCheck, withdraw_request}` | `reqUp_inv`, `reqDown_inv`, `allUp_inv`, `allDown_inv`, `edited_blocks_build`, `only_valid_builds`, `withdraw_needs_validated_recipient`, `withdraw_within_bounds` |

Concrete vectors are `example ... := by decide` in each module and the same numbers are asserted in
`tests/{gate,swap,txbuilder,orderform,txforms}.rs` (OrderForm: cost 66 666 666 / 66 666 667 at price 0.3, the 20 / 10 token acceptance pair, fee vectors 0.0012 / 0.0024; Forms: stepper corners, withdraw 0.001 / maximum bounds; vectors A/B/C, the 400+400+400 reservation of a 1000 order, the
six-step run, the 59 999/60 000 ms deadline, the gate cases).

Where the models abstract: trade/session ids are `Nat` (SHA-256 ids in Rust); the transcript digest
is the list of accepted steps (collision-free hash assumption); payload validity is a `Bool`; token
comparison is equality (the constant-time property is not modelled); `OrderForm` folds balance minus reservations into one `avail`, takes the UTXO list sorted largest first and models the binary search by its monotonicity (`fitsLtc_downward`), form/key/attestation/market guards are `Bool`s; `Forms` takes the parsed amount, and key slots, pubkey validity and the one-HOT-key rule of `MultisigForm` are covered by the Rust tests only; `Order` is one order (Rust
keeps one reservation list per order); UTXOs are amounts in candidate order (sorting and outpoint
de-duplication are Rust-only and tested there); `Option` stands for `Result`.

## Not ported / remaining gaps

* **Key derivation and signing** (`bip39`/`bip32` mnemonic and path derivation, WIF handling,
  `signAllInputs`, `finalize`): left behind `KeyBackend`/`SignBackend`. Per the charter signing needs a
  separately reviewed capability boundary; only the guards in front of it are ported. The legacy FE
  `getWifByAddress` is a stub returning `''`, so the swapper signing path is not functional in the
  pinned snapshot either.
* HTTP/socket.io transports, the Electron launcher and process spawning for `litecoind.exe`
  (the `exec` call is commented out in the pinned source), the Angular UI, toasts, sounds, dialogs.
* `clientstate` (attestation, positions, channel commits, node reward, sync, auth address lists) has no
  Lean model; its properties (one claim per address per round, bounded retries) are Rust tests only.
* Not ported from `wallet-fe`: UI components and templates, toasts/sounds, dialogs plumbing, the sign tabs'
  private-key handling (`privKeys`, `activeKeyPair.privkey` fallback sent to `signrawtransaction`, kept
  behind `SignBackend`), `auth.service(old).ts` (dead copy), the commented-out bodies (`addLiquidity`,
  `newSpotAddress`, multisig `create`/`save`, node-reward `onInit`), pure RPC pass-through
  (`decode`/`send` tabs, `rpc()` forwarding), the orderbook/history/markets services beyond `market`.
  `*-orders.service.ts` only emits socket events and has no logic.
* The buy/sell card test vectors are produced from slices of the pinned TypeScript methods bound to a fake
  `this` (`scripts/compare-orderform.cjs`); the Angular form controls and `balanceService` are not
  loaded. The `txforms` and `clientstate` vectors are hand-derived from the source.
* The swap driver (calling the allowlisted RPCs between steps) is not written; `swap::checks` and
  `psbt::check_trade_psbt` are the pure pieces it needs.
* Not run: the legacy TS tests (none exist), an end-to-end run against a regtest/testnet node, and any
  property fuzzing beyond the grid in `conservation_over_a_grid`.
* Legacy parity covers selection/fee arithmetic (`scripts/compare-legacy.cjs`) and the buy/sell card
  methods (`scripts/compare-orderform.cjs`); the orderbook math in the Angular services cannot be loaded
  without Angular, so its vectors in `tests/misc.rs` are hand-derived.
