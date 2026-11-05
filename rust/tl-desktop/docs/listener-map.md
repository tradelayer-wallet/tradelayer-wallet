# FE-speed listener endpoints and TradeLayer-Rust

FE-speed's desktop UI talks to a Node TradeLayer listener on `:3000` (`tradelayer.js`). tl-desktop
reaches it two ways: the `/tlraw/*` passthrough (the UI's direct `http://localhost:3000/...` calls,
rewritten at build time) and FE-speed's `/tl/*` routes (`routes/tradelayer.route.ts`, served by
`tl-wallet-service`). Both go through one seam, `ListenerBackend`.

Two backends exist:

* **default**: `ListenerClient`, plain HTTP to `tl_listener_url`. Unchanged.
* **opt-in**: `RustEngineListener` (`src/engine.rs`), selected with `tl_engine = "tradelayer-rust"`.
  Each listener endpoint is mapped to a JSON-RPC method of `tradelayer-rpcd` and the reply is
  reshaped to what FE-speed parses.

## What TradeLayer-Rust ships today

Read at TradeLayer-Rust `f3fea57fe0f6e83188c22b32f4117db01b285012` (read-only).

| Piece | What it is | Serves |
|---|---|---|
| `tradelayer-rpcd` (`src/bin/tradelayer-rpcd.rs`, `src/rpc_server.rs`) | Read-only JSON-RPC 2.0 over loopback HTTP (`POST /`, one request per connection, no auth), over one restored TLJP checkpoint; DRAFT shapes (`docs/RPC_READONLY.md`) | **6 methods**: `tl_getinfo`, `tl_getsyncstatus`, `tl_listproperties`, `tl_getproperty`, `tl_getbalance`, `tl_getallbalancesforaddress` |
| `service_routes` + `http_service` + `service_runtime` + `service_view` (library only) | The pinned `listener.js` / `walletListener.js` route tables (19 + 43 routes) over an `EconomicReadBackend`; HTTP faces as `EconomicHttpService` | Positions, trade history, channels, attestations, contract info, ... but **no binary launches it** (`docs/SERVICE_HTTP.md`: "a service launcher remain operator integration work") |
| `tl_observe` (`src/bin/tl_observe.rs`) | Follows a Litecoin/Bitcoin node over RPC into an `ObservationStore` under `--root` | Nothing over the network; its store is not a TLJP checkpoint, so rpcd cannot read it |

Consequences for this adapter:

* rpcd has no live feed: it serves whatever heights and balances its checkpoint was written with.
  There is no `tl_observe` to rpcd path; a checkpoint comes from `JointProtocolState::snapshot_bytes`.
* Of FE-speed's 30 listener endpoints, rpcd can answer 9 (shape-adapted). The other 21 need
  state rpcd's checkpoint view does not expose. They answer the listener's own *unavailable* reply.
* The complete answer is the library's `EconomicHttpService`, which already speaks FE-speed's
  listener routes. When TradeLayer-Rust gains a launcher binary for it, point `tl_listener_url` at it
  (default engine, no adapter) and these 21 gaps close on the TradeLayer-Rust side. The shapes it
  uses (heights, `{"error":"unavailable","capability":...}`, `No channel found` reply) are the ones
  this adapter copies where rpcd gives it no data of its own.

## Config

```json
{
  "tl_engine": "tradelayer-rust",
  "tl_engine_url": "http://127.0.0.1:7360",
  "tl_engine_cmd": "C:/tools/tradelayer-rpcd.exe",
  "tl_engine_args": ["--checkpoint", "C:/tl/state.tljp", "--network", "litecoin",
                     "--admin", "<admin account>", "--permitted", "7,9",
                     "--bind", "127.0.0.1:7360"]
}
```

* `tl_engine`: `"http"` (default, the passthrough to `tl_listener_url`) or `"tradelayer-rust"`.
* `tl_engine_url`: plain-`http` loopback origin of rpcd; default `http://127.0.0.1:7360`
  (rpcd's own default bind). `https`, non-loopback hosts, userinfo, path, query: refused.
* `tl_engine_cmd` / `tl_engine_args`: optional sidecar. Absolute path. No process is started
  unless both `tl_engine = "tradelayer-rust"` and `tl_engine_cmd` are set. `--allow-nonloopback`
  is refused and a `--bind` must equal the `tl_engine_url` authority.
* `tl_engine_url`, `tl_engine_cmd`, `tl_engine_args` without `tl_engine = "tradelayer-rust"` are
  a config error, not ignored.
* `tl_listener_url` and `tl_rpc_via_listener` keep their meaning for the default engine.

## Sidecar (`src/engine_sidecar.rs`)

One supervisor thread (`tl-engine`) owns the child. It restarts the child when it exits, waiting
500 ms, doubling to 30 s, back to 500 ms after a run of 60 s or more. The child gets no stdin, no
console window and a piped stderr whose last line is kept for status. The app's `RunEvent::Exit`
(and `Drop`) kill the child and join the thread. A hard crash of the app cannot run that hook
(`#![forbid(unsafe_code)]` excludes a Windows job object): rpcd is read-only and loopback-only, and
the next start finds the port busy and backs off.

## Mapping

Class: **exact** = rpcd answers with the listener's shape; **adapted** = rpcd method, reply
reshaped; **missing** = no rpcd method, listener "unavailable" reply. Counts: 0 exact, 9 adapted,
21 missing (30 endpoints: 19 POST, 11 GET).

rpcd methods are lower-case and take positional params. Property ids are positive `u32` JSON
numbers, addresses are printable ASCII up to 90 bytes, money is a JSON string of integer atoms.

### Served (adapted)

| FE-speed endpoint | rpcd call | Request | Reply to FE-speed |
|---|---|---|---|
| `POST tl_initmain` | `tl_getinfo []` | body ignored (FE-speed sends `{wallet:true}`) | `{"initialized":true,"scope":"checkpoint_read_service","daemonStarted":false,"authenticated_admission":false,"network":"litecoin","finalizedHeight":42}`. `/tl/init` only needs 2xx and no `error` field. Starts nothing |
| `POST tl_getSyncStatus` | `tl_getsyncstatus []` | none | `{"source":"checkpoint","available":false,"consensus":<finalized_height\|null>,"txIndex":null,"trackHeight":null,"synced":null,"processedCount":n}` |
| `POST tl_checkSync` | `tl_getsyncstatus []` | none | `{"available":false,"consensus":h,"txIndex":null,"trackHeight":null,"synced":null}`: parser and tracker heights are unknown, so `available` is false and `synced` null |
| `POST tl_getMaxProcessedHeight` | `tl_getsyncstatus []` | none | `{"maxProcessedHeight":h}` (finalized height; `null` if the checkpoint has none) |
| `POST tl_getMaxParsedHeight` | `tl_getsyncstatus []` | none | `{"maxParsedHeight":null}` (a checkpoint has no parser height; the call still proves rpcd is up) |
| `POST tl_getTrackHeight` | `tl_getsyncstatus []` | none | `{"trackHeight":h,"source":"maxProcessed"}` |
| `POST tl_getAllBalancesForAddress` | `tl_getallbalancesforaddress [addr]` | `{"params":"addr"}` (FE-speed) or `{"address":"addr"}`; both must agree | `[{"propertyId":7,"amount":250.0,"available":250.0,"reserved":0,"margin":0,"vesting":0,"channel":0}, ...]` in ascending property id. Unknown account: `[]`. No `ticker` (UI shows `-`) |
| `POST tl_listProperties` | `tl_listproperties []` | none | `[{"id":7,"propertyId":7,"issuer":"alice","kind":"fixed","totalSupply":1000.0,"totalSupplyAtoms":"100000000000"}, ...]`. No `ticker`: the checkpoint carries none |
| `POST tl_getProperty` | `tl_getproperty [id]` | `{"params":7}` or `{"params":"7"}` (canonical unsigned, 1..=u32 max) | the row above for one property. Unknown id: `404 {"error":"not_found"}` |

Amounts: `atoms / 1e8` as a JSON number (decimal text, one rounding by the float parse). That is the
scale TradeLayer-Rust renders amounts with. rpcd serves the **available** balance only, so
`amount` equals `available` and `reserved`, `margin`, `vesting` and `channel` are `0` here: they
are not served, not known to be zero. rpcd does not mark indivisible properties.

Reply mapping for every served call: rpcd `-32001` is `404 {"error":"not_found"}`, `-32602` is
`400 {"error":"invalid_request"}`, `-32601` is `503 unavailable` (a newer listener contract than
this build), any other JSON-RPC error is `500 {"error":"backend","capability":"<method>"}`; a
non-200 from rpcd, or a 200 that is not a JSON-RPC 2.0 reply carrying our request id, is
`502 {"error":"transport"}`. A refused connection or a timeout is a transport error worded like
axios (`connect ECONNREFUSED 127.0.0.1:7360`, `timeout of 5000ms exceeded`), so `/tlraw/*` answers
502 and `/tl/*` answers FE-speed's `Error: ...` reply exactly as with a down Node listener.

### Not served (missing)

Reply: `503 {"error":"unavailable","capability":"<name>"}`, the listener's own shape
(`http_service.rs` `error_response`). Through `/tlraw/*` that status and body reach the UI as
they are; through `/tl/*` FE-speed's routes turn any non-2xx into `500 "Error: Request failed with
status code 503"`, the same thing a failing Node listener produces. Nothing is answered with an
invented empty result. rpcd is never called for these.

| FE-speed endpoint | Verb | Capability | Why rpcd cannot answer |
|---|---|---|---|
| `tl_loadWallet` | POST | `wallet_load` | not a read capability |
| `tl_getStateSnapshot` | POST | `state_snapshot` | no snapshot export |
| `tl_getChannel` | POST | `channel_view` | checkpoint view has no channels |
| `tl_getChannelColumn` | POST | `channel_lifecycle_view` | no column prediction (also unavailable in `service_view`) |
| `tl_getAttestations` | POST | `attestation_registry` | no registry view |
| `tl_getTransaction` | POST | `transaction_index` | no transaction index |
| `tl_getClearlistById` | POST | `clearlist_registry` | no registry view |
| `tl_listContractSeries` | POST | `contract_registry` | no contract view |
| `tl_watchonly_register`, `tl_watchonly_utxos` | POST | `watchonly_index` | collator-only, not in rpcd |
| `tl_contractPosition` | GET | `contract_positions` | no positions |
| `tl_getContractInfo`, `tl_getInitMargin` | GET | `contract_registry` | no contract view |
| `tl_channelBalanceForCommiter` | GET | `channel_view` | no channels |
| `tl_getMaxSynth` | GET | `synthetic_metadata` | no synthetic metadata |
| `tl_tokenTradeHistoryForAddress` | GET | `spot_fill_owner_history` | no fill history (spot fills retain no owner in TradeLayer-Rust either) |
| `tl_contractTradeHistoryForAddress`, `tl_contractTradeHistory` | GET | `contract_history` | no history |
| `tl_totalTradeHistoryForAddress` | GET | `address_history` | no history |
| `tl_fundingHistory` | GET | `funding_history` | no history |
| `tl_oracleHistory` | GET | `oracle_history` | no history |

That is 10 POST and 11 GET: 21 endpoints. `tl_check_kyc` and `tl_check_commits` are not in
FE-speed's listener allowlist (porting map 1.8) and are not routed by tl-desktop at all (`/tlraw/`
answers 404 for them, as for any name off the list); the adapter itself answers an unlisted endpoint with
`404 {"error":"not_found"}`.

`/tl/*` routes that are not listener-backed (`/tl/test`, `/api/*`) are untouched.

## Tests

* `src/engine.rs`: a mock JSON-RPC server answering with TradeLayer-Rust-shaped replies (the seeded
  state of its `tests/rpc_server.rs`: properties 7 and 9, carol holding both, finalized height 42,
  exact reply bytes from `docs/RPC_READONLY.md`). One test per served endpoint, one sweep over all
  21 missing endpoints (503 shape, rpcd never called), request-validation, failure-mode, config and
  bridge tests (`legacy::translate` then `handle_request`), plus a check that the default engine
  is still the HTTP passthrough.
* `src/engine_sidecar.rs`: restart with backoff, stop, never-started-unless-configured, missing
  binary, using the test executable as the child.
* `real_rpcd_serves_fe_speeds_endpoints_through_the_tlapi_bridge` (`#[ignore]`): starts the real
  rpcd as the sidecar on `testdata/engine/rpcd_checkpoint.tljp` and drives 11 calls through the
  bridge.

```bat
set TL_RPCD_BIN=C:\path\to\tradelayer-rpcd.exe
build-desktop.cmd test --locked -- --ignored real_rpcd
```

### Building rpcd

TradeLayer-Rust is dependency-free and builds with the stock toolchain. The binary used here was
built from a `git archive` of TradeLayer-Rust `f3fea57fe0f6e83188c22b32f4117db01b285012` (clean
tree) with Windows MSVC, Rust 1.90.0:

```bat
cargo +1.90.0-x86_64-pc-windows-msvc build --release --bin tradelayer-rpcd --locked
```

with `CARGO_TARGET_DIR` outside the repository.

### Fixture recipe

`testdata/engine/rpcd_checkpoint.tljp` is `JointProtocolState::snapshot_bytes()` of the state
below, written by `testdata/engine/gen_checkpoint.rs.txt` (a short `main` against
`tradelayer_core`, same seeding as TradeLayer-Rust's `tests/rpc_server.rs` `finalized_state`, with
whole-unit amounts): Litecoin, admin `admin`, permitted properties 7 and 9, finalized height 42,
property 7 issued by alice (1000 units) with carol holding 250, property 9 issued by bob (5 units,
managed) with carol holding 1.5. Start rpcd on it with
`--network litecoin --admin admin --permitted 7,9`.
