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
server is started and which origin the renderer has). Pinned oracle: `tx-builder.service.ts` blob
`2b11ba8ed36dce681cc11b5777fc2041efb62f21`.

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
| Dust threshold for change outputs | **open** | `tx-builder.service.ts` | change is emitted when > 0, as legacy |
| OP_RETURN payload tail is the buyer's `tl_getinfo` block + 100 | **open** | `buyer.ts:68` | `check_trade_psbt` can only check a payload prefix |

## Commands

```sh
cd rust/tl-wallet-service
cargo test --locked --offline
cargo clippy --locked --offline --all-targets -- -D warnings
cargo fmt --all -- --check
node scripts/compare-legacy.cjs | diff - scripts/legacy-vectors.json   # needs the repo checkout; --write refreshes
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

Concrete vectors are `example ... := by decide` in each module and the same numbers are asserted in
`tests/{gate,swap,txbuilder}.rs` (vectors A/B/C, the 400+400+400 reservation of a 1000 order, the
six-step run, the 59 999/60 000 ms deadline, the gate cases).

Where the models abstract: trade/session ids are `Nat` (SHA-256 ids in Rust); the transcript digest
is the list of accepted steps (collision-free hash assumption); payload validity is a `Bool`; token
comparison is equality (the constant-time property is not modelled); `Order` is one order (Rust
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
* Positions, node-reward and attestation services contain no arithmetic (RPC pass-through with
  string parsing) and are covered by the RPC allowlist only.
* The swap driver (calling the allowlisted RPCs between steps) is not written; `swap::checks` and
  `psbt::check_trade_psbt` are the pure pieces it needs.
* Not run: the legacy TS tests (none exist), an end-to-end run against a regtest/testnet node, and any
  property fuzzing beyond the grid in `conservation_over_a_grid`.
* Legacy parity covers selection/fee arithmetic only (`scripts/compare-legacy.cjs`); the orderbook
  math in the Angular services cannot be loaded without Angular, so its vectors in `tests/misc.rs`
  are hand-derived.
