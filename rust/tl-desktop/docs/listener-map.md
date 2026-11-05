# FE-speed listener endpoints and TradeLayer-Rust

FE-speed's desktop UI talks to a Node TradeLayer listener on `:3000` (`tradelayer.js`). tl-desktop
reaches it two ways: the `/tlraw/*` passthrough (the UI's direct `http://localhost:3000/...` calls,
rewritten at build time) and FE-speed's `/tl/*` routes (`routes/tradelayer.route.ts`, served by
`tl-wallet-service`). Both go through one seam, `ListenerBackend`.

Three ways to run it:

* **default**: `ListenerClient`, plain HTTP to `tl_listener_url`. Point it at `tradelayer-listenerd`
  (below) and the UI works with no adapter.
* **`tl_engine = "tradelayer-listenerd"`**: the same `ListenerClient`, plus the daemon as an optional
  sidecar (README, "Running tradelayer-listenerd").
* **`tl_engine = "tradelayer-node"`**: the same `ListenerClient`, plus the live node as an optional sidecar
  (below; README, "Running tradelayer-node").
* **opt-in**: `RustEngineListener` (`src/engine.rs`), selected with `tl_engine = "tradelayer-rust"`.
  Each listener endpoint is mapped to a JSON-RPC method of `tradelayer-rpcd` and the reply is
  reshaped to what FE-speed parses.

## tradelayer-node: the live listener (no adapter)

`tradelayer-node` (TradeLayer-Rust `docs/NODE.md`) follows a Bitcoin Core node (BTC or BTC-TESTNET4), applies
authenticated blocks to a durable economic chain and serves the same legacy listener routes as
`tradelayer-listenerd` on a loopback bind, so the passthrough and the mappings of the next section apply to it
unchanged. What differs is the status: `tl_initmain` / `GET /initstatus` reports `scope:"node"` and
`authenticated_admission:true` once the running node has applied an admitted block (input 0 only, P2PKH or
P2WPKH parents, SIGHASH_ALL; inclusion proven against the header), with `admitted_blocks`, `height_base`,
`observed_tip` and `economicHead`. Config: `tl_engine = "tradelayer-node"` plus a `tl_node` object
(README, "Running tradelayer-node"). The per-endpoint table below was probed against `tradelayer-listenerd`
only; the node's replies were not probed through this crate.

## tradelayer-listenerd: the listener replacement (no adapter)

`tradelayer-listenerd` (TradeLayer-Rust `9b586a0`, `docs/LISTENERD.md`) serves all 62 routes of the pinned
`listener.js` / `walletListener.js` over one restored store on loopback, status
`authenticated_admission:false` (no live chain ingest). Routes its store cannot back answer
`503 {"error":"unavailable","capability":...}`; a route it does not have answers
`404 {"error":"not_found"}`. With `tl_listener_url` at the daemon the passthrough carries FE-speed's calls
unchanged; `src/legacy/listenerd.rs` applies the few shape mappings below, each keyed on a marker only
the daemon's reply has (a Node listener's replies pass through untouched).

Class per FE-speed endpoint (30: 19 POST, 11 GET), probed against a `--demo-seed` store:
**served** = 2xx with data, **mapped** = the daemon's reply reshaped for the UI (what changes is in the
last column), **typed 503** = the daemon's own typed-unavailable reply, passed through. The rpcd columns
are the table further down.

| FE-speed endpoint | rpcd adapter | listenerd | Mapping applied (`legacy/listenerd.rs`) |
|---|---|---|---|
| POST `tl_initmain` | adapted | served | none |
| POST `tl_getSyncStatus` | adapted | **mapped** | the daemon has no such route (404); `tl_checkSync` stands in: `{available:false, consensus:h, synced:null, source:"listenerd", initialized:true}` |
| POST `tl_getMaxParsedHeight` | adapted | served | none (`{"maxParsedHeight":null}`) |
| POST `tl_getMaxProcessedHeight` | adapted | served | none |
| POST `tl_getTrackHeight` | adapted | served | none (`source:"maxProcessed"`) |
| POST `tl_checkSync` | adapted | served | none |
| POST `tl_loadWallet` | missing | typed 503 `wallet_rpc` | none |
| POST `tl_getStateSnapshot` | missing | **mapped** to typed 503 `state_snapshot` | daemon 404 to its own typed-unavailable shape |
| POST `tl_getAllBalancesForAddress` | adapted | served, **mapped** | rows gain JSON numbers `amount`, `available`, `reserved`, `margin`, `channel` (atoms / 1e8) from `ownedAtoms`, `availableAtoms`, `contractReserveAtoms + spotReserveAtoms`, `contractMarginAtoms`, `channelAtoms`; the atom fields stay; the daemon's string `available:"79899.85"` becomes a number. `{params:[a]}` becomes `{params:a}` |
| POST `tl_getChannel` | missing | served, **mapped** | unknown channel: daemon `404 not_found` becomes the listener's `200 {message:"No channel found for the given address", channel:null}` |
| POST `tl_getChannelColumn` | missing | typed 503 `channel_lifecycle_view` | body gets `newCommitAddress` from `buyerAddress`/`myAddress`: the UI's direct call names the buyer, the listener (and the daemon, 400 otherwise) reads `newCommitAddress` |
| POST `tl_listProperties` | adapted | served, **mapped** | rows gain `id` (= `propertyId`) |
| POST `tl_getProperty` | adapted | served, **mapped** | row gains `id`; `{method, params:[7]}` (`rpc-call` of `tl_getproperty`) becomes `{params:7}` |
| POST `tl_getAttestations` | missing | served | none (`[]` for an unattested address) |
| POST `tl_getTransaction` | missing | typed 503 `authenticated_transaction_index` | none |
| POST `tl_getClearlistById` | missing | served | none (`404 not_found` for an unknown list) |
| POST `tl_listContractSeries` | missing | typed 503 `accepted_contract_catalog` / `accepted_contract_definition` | none |
| POST `tl_watchonly_register`, `tl_watchonly_utxos` | missing | **mapped** to typed 503 `watchonly_index` | daemon 404 to typed-unavailable |
| GET `tl_contractPosition` | missing | served, **mapped** | gains `avgPrice`, `margin`, `unrealizedPNL` (numbers) and numeric `contracts`; no `bankruptcyPrice` (not served, stays absent) |
| GET `tl_getInitMargin` | missing | served | none (a JSON string, `Number()`-ed by the UI) |
| GET `tl_channelBalanceForCommiter` | missing | served | none (`{scope:"ledger_channel", channelAtoms}`; the UI reads `rows`/`total`, absent here, and shows none) |
| GET `tl_getContractInfo`, `tl_getMaxSynth` | missing | typed 503 `accepted_contract_definition`, `synthetic_vault_store` | none |
| GET `tl_tokenTradeHistoryForAddress`, `tl_contractTradeHistoryForAddress`, `tl_totalTradeHistoryForAddress`, `tl_contractTradeHistory` | missing | typed 503 `spot_fill_owner_history`, `contract_owner_history` | none |
| GET `tl_fundingHistory`, `tl_oracleHistory` | missing | typed 503 `funding_history`, `retained_oracle_observations` | none |

Counts: 14 served (5 of them mapped), 1 answered by fallback (`tl_getSyncStatus`), 15 typed 503 (3 of them
produced from the daemon's 404). The rpcd adapter answers 9 of the 30. `tl_check_kyc` and
`tl_check_commits` are TradeLayer protocol queries (the attestation registry and channel commit
records, `clearlist.js` and `channels.js` in tradelayer.js), not node RPCs: the 2024 UI sends them as
`rpc-call`, and tl-wallet-service answers both from the listener in every mode (body `{address}`, reply in
the `{data}` envelope; see "KYC and commit checks" below). They are not in FE-speed's `/tlraw/` allowlist.

The UI tolerates the 503s: `enrichWithContractInfo`, `predictColumn` and the trade-history and channel
services catch the axios error and keep their empty state; through `/tl/*` a non-2xx is FE-speed's
`Error: Request failed with status code N` reply, as with a failing Node listener. Gaps the daemon owns,
not papered over here: no `ticker` or `name` on properties (balance rows show `-`), no contract series or
contract info (the futures cards cannot compute leverage), no trade history, no channel view, and a static
store (`authenticated_admission:false`). `tl_getContractInfo` has no catch in `txs.service.ts`; the order
flow that calls it needs a store with an accepted contract.

Run the integration test against a running daemon (README, "Running tradelayer-listenerd"):
`real_listenerd_serves_fe_speeds_routes_through_the_tlapi_bridge`, 30+ bridge calls.

## What TradeLayer-Rust shipped when the rpcd adapter was written

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
  listener routes. TradeLayer-Rust has since gained its launcher, `tradelayer-listenerd` (section above):
  point `tl_listener_url` at it (default engine, no adapter). The shapes it
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
FE-speed's listener allowlist (porting map 1.8; `/tlraw/` answers 404 for them, as for any name off the
list). `rpc-call` sends them to the listener as `POST /tl_check_kyc` / `POST /tl_check_commits` with
`{address}`; the adapter answers an unlisted endpoint with `404 {"error":"not_found"}`, which `rpc-call`
reports as a 500.

### KYC and commit checks

Both are protocol state, so they are answered by whichever engine holds TradeLayer state, whatever chain
the node runs. Expected listener replies (raw JSON; tl-wallet-service wraps them in `{data}`):

| Endpoint | Reply | Source of truth |
| --- | --- | --- |
| `tl_check_kyc` | `{"result: ": "enabled(kyc_0)" \| "enabled" \| "disabled"}` (key keeps the trailing space) | an active attestation for the address gives `enabled(kyc_0)` (`clearlist.js` `isAddressInClearlist`, revoked records excluded); an address that administers a clearlist gives `enabled`; otherwise `disabled` (tradelayer-core `tl_check_kyc` gives the same three values) |
| `tl_check_commits` | `[{sender, channel, propertyId, amount, block}]` | every commit record whose `senderAddress` is the address, across channels (`channels.js` `recordCommitToChannel` pushes `{senderAddress, propertyId, tokenAmount, block}` onto `channel.commits`) |

The 2024 UI reads `data['result: '] === 'enabled(kyc_0)'` and `parseFloat(amount)` / `parseFloat(propertyId)`,
so string or number values both work. FE-speed calls neither: it uses `tl_getAttestations` and
`tl_channelBalanceForCommiter`.

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

## Test double for the swap run

`scripts/tl-listener-double.mjs` answers the endpoints above over plain HTTP for runs against a
Bitcoin Core regtest node (see the README, "FE-speed two-party swap"). It is not TradeLayer consensus:
it reads the `tl4...` (commit) and `tlk...` (channel trade) OP_RETURN strings FE-speed's encoder writes,
keeps mined balances, channel balances (`channel` in `tl_getAllBalancesForAddress`) and token trade
history from them, and derives channels and columns (first committer is `A`, mempool commits count)
for `tl_getChannel`, `tl_getChannelColumn` and `tl_channelBalanceForCommiter`. Attestations answer
`active` for every address, `tl_getInitMargin` a constant, positions are flat. Tests:
`node --test scripts/tl-listener-double.test.mjs`.
