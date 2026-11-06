# tl-desktop

The TradeLayer desktop wallet as a Tauri 2 application: a native window (WebView2 on Windows)
that runs the **original Angular wallet UI** (`packages/wallet-fe`, components, services and
templates unchanged) on a Rust backend. It replaces the Electron main process (`builder/`) and
the Node `wallet-server` (`packages/wallet-server/`).

* Toolchain: Rust 1.90.0 (`rust-toolchain.toml`), Tauri 2.12.5, committed `Cargo.lock`;
  Angular 12.1.5 built with Node 24 (`--openssl-legacy-provider`).
* Licence: ISC (as the repository `package.json`).

## Default build: the FE-speed wallet with the chrome skin

The app ships the UI of branch **`FE-speed`**, the current desktop wallet (v0.0.16: Spot and
Futures Trading, Algo Trading, BitVM, WebRTC and Servers windows). It is built from that git ref
with the `fe-speed` overlay and the `fe-speed-skin` layer, and `tauri.conf.json` points
`frontendDist` at the result:

```bat
set BITCORN_WISDOM_DIR=<clone of patrickdugan/BitcornWisdom at 2cbef833>
node scriptsuild-ui.mjs --ref origin/FE-speed --name fe-speed --skin fe-speed-skin
```

* **`ui-overlay/fe-speed`**: FE-speed's build plumbing.
  * The `tauri` Angular configuration.
  * Count-checked rewrites: `http://localhost:3000/` → `tlapi` `/tlraw/`, and `tl-api` →
    `homeApiUrl` `/tl/`.
  * Main-socket reconnect with watchdog.
  * `ui-shim/fe-speed-shim.js`, which provides `window.tradelayerElectron`.
* **`ui-overlay/fe-speed-skin`**: the facelift and the charts.
  * The facelift keeps FE-speed's palette (`#130f23` / `#1c1932` / `#2c304a` surfaces, `#45a8fb` /
    `#306bf3` accents) and adds chrome gradients on the header, tabs, buttons, card frames and
    status bar.
  * Spot and futures charts are BitcornWisdom (pinned 2cbef833, bundled under `bitcorn/`). It
    reads public candle feeds from Kraken, Coinbase and Binance (spot and USD-M perpetuals);
    `ui-overlay/fe-speed-skin/csp.json` lists every host with a reason.
* **CSP**: `frame-ancestors 'self'`, so the app can frame its own chart page; the exchange feed
  hosts are in `connect-src`.
* **Backend**: FE-speed's `wallet-server` routes are served by Rust.
  * `/tlraw/*` and `/tl/*` go to the TradeLayer listener at `tl_listener_url`.
  * Key and signing routes return opaque handles (`tlk1:` held in Rust, `tln1:` = node wallet).
    No WIF or private key reaches the page.
* **Orderbook**: reached through the raw-WebSocket relay (`orderbook_urls`, default
  `ws://172.81.181.19:3001`).

The master-branch UI below is still buildable with `node scriptsuild-ui.mjs` and a `TAURI_CONFIG`
override of `frontendDist` to `dist-ui`. Its e2e scripts target the legacy socket.io orderbook.

## How the original UI runs without Electron or Node

| Electron wallet | tl-desktop |
|---|---|
| Node `wallet-server` on `localhost:1986` (Fastify + socket.io, no authentication; see `rust/tl-wallet-service/README.md`) | No listening socket. The UI's `homeApiUrl` is `http://tlapi.localhost`, a Tauri custom URI scheme served in-process (`src/legacy.rs`) by `tl-wallet-service`, so only this webview can reach it. The bridge holds the session token itself. |
| socket.io server for the main socket, `new-block`, `core-error` | `src/socketio.rs`: Engine.IO v4 long-polling + socket.io v5 on the same scheme; `new-block`/`core-error` from a 5 s `getblockchaininfo` probe through the same gate as page calls |
| `ob-sockets.service.ts`: a raw WebSocket client (`ws`) to whatever orderbook URL the page names, relaying `OB_SOCKET::*` events, the order events and `<socketId>::swap` between the orderbook server (HyperExpress/uWebSockets, JSON text messages) and the UI's socket.io main socket | `src/obrelay.rs`: the same relay, a blocking `tungstenite` client (rustls for `wss://`) on its own threads, with the same message mapping (table in the module doc). Server→UI: the flat message `{event, ...}` becomes `OB_SOCKET::<event>` with the whole message for `connected` (the hello with the socket id), `order:error`, `order:saved`, `placed-orders`, `orderbook-data`, `update-orders-request`, `amended`, `auth_ok`, `auth_ignored`; `new-channel` and `<counterparty>::swap` are unwrapped from `msg.data`; open/close/failure become `OB_SOCKET::connect` (payload `{}`), `disconnect`, `connect_error`. UI→server: `update-orderbook`, `new-order`, `close-order`, `many-orders`, `orderbook:join`, `orderbook:leave`, `amend-order`, `auth` and `OB_SOCKET::new-channel` as flat `{event, ...payload}` (an `event` key in the payload never replaces the name); `<own id>::swap` as `{event, eventName, socketId, data}`. Only origins in `orderbook_urls` are contacted (legacy connected to any URL), the path must be `/` or `/ws`; event names outside these lists are dropped; messages and queues are bounded. The relay is a `web` class client and logs the UI's trading addresses in to the orderbook itself (`src/obauth.rs`, see "Orderbook login") before it forwards their orders, so the page never handles a key or a session token |
| `rpc-call` forwards any node method, including `dumpprivkey` | `tl-wallet-service` gate method allowlist. `dumpprivkey` is never forwarded: it answers the node-wallet handle `tln1:<address>` (FE-speed posts what it gets to the sign routes). `signrawtransaction` refuses private keys in its key list. `signrawtransactionwithwallet [rawtx]`, the swapper's commit-transaction call, runs the sign guard (chain amounts, fee ceiling) before the node wallet signs |
| `keys/*` routes return mnemonic, private key and WIF to the page; `sign-tx`/`sign-psbt` take a WIF from the page | Key handles (`src/legacy/keyvault.rs`, `localsign.rs`). `keys/get-address*` derive in Rust from the mnemonic the page supplies (FE-speed shows and stores the mnemonic for backup, unchanged) and answer `{address, pubkey, privkey: "", wif: "tlk1:<128-bit id>"}`; the key stays in a bounded in-memory table (1024 keys, least recently used evicted, 12 h idle expiry, erased on drop, emptied by `/api/logout`, `/keys/logout` and `stop-wallet-node`). `sign-tx`/`sign-psbt` run the service guards, then resolve `tlk1:` to the key and sign with FE-speed's semantics, byte-identical to its `crypto.util.ts`; `tln1:<address>` and an empty `wif` go to the node wallet (a `tln1:` handle only for inputs of that address); on descriptor wallets (Bitcoin Core 30+/31, Litecoin Core) a `tln1:` PSBT signature first adds the address key's `bip32_derivation` (key origin from `getaddressinfo`) to each channel-multisig input, so the node signs a `wsh(multi(2,A,B))` script it never imported, and `isValid` means the node signed with that key; the added entries are stripped from the returned PSBT; a real WIF is refused |
| Electron main process: `window.require('electron')` IPC for the folder picker and auto-updater | `ui-shim/electron-shim.js`, loaded before the bundles, provides the `ipcRenderer` the UI calls. `check-version` is answered with the updater's "up to date" state (no auto-updater in this build); folder picker and download are dropped (the dialog keeps its text field) |
| Chromium with Node integration | WebView with CSP: `script-src 'self'` (no inline script, no eval); inline styles allowed (Angular injects component styles); fonts from Google Fonts as in the legacy `index.html`; `connect-src` limited to IPC, `tlapi` and the four relayer/orderbook endpoints in `environment.ENDPOINTS`. The capability list is empty: no Tauri core or plugin command (fs, shell, http, event) is granted. |

`freezePrototype` is off: zone.js and crypto-js in the legacy bundle assign `Object.prototype`
members and fail on a frozen prototype.

The UI build adds only an `angular.json` configuration `tauri` and `environment.tauri.ts`
(`homeApiUrl`, critical-CSS and font inlining off so no inline event handler is emitted).

The Spot Trading and Futures Trading screens and the Servers window are switched back on in
`app-routing.module.ts`, the header menu and `windows.service.ts`. Commit `bd0ce5c` (2024-01-29,
"update the app to work with vanilla litecoin wallets") had commented them out, and they are
restored exactly as they were with no guards, like Portfolio. Node Reward and Login stay off.

## Second mode: Rust-held keys (`tl-desktop-core`)

`src/main.rs` also exposes ten IPC commands over [`tl-desktop-core`](../tl-desktop-core):
`status`, `create_wallet`, `import_wallet`, `unlock`, `lock`, `receive_address`, `balance`,
`prepare_send`, `confirm_send`, `cancel_send`. Keys live in an encrypted vault on the Rust wallet
thread; a send is previewed first and only `confirm_send` grants the one-use signing capability
bound to the previewed inputs, outputs and fee. `ui/` is the test surface for these commands; the
Angular UI does not call them yet.

## Layout

* `src/main.rs`: window setup, the `tlapi` scheme, the IPC commands, the wallet thread.
* `src/legacy.rs`: request translation, CORS, the `legacy` thread owning `WalletService`, node
  JSON-RPC client (loopback http or https, no proxy/redirects, 8 MiB cap), relayer client,
  `litecoin.conf` store restricted to `node_data_dir`.
* `src/socketio.rs`: the socket.io server.
* `src/obrelay.rs`: the orderbook relay (allowlist, the socket.io packet codec for the UI side,
  relay mapping, WebSocket client on its own threads).
* `src/obauth.rs`: the orderbook login state machine and its HTTP worker; `src/authsign.rs`:
  signing the challenge on the `legacy` thread (key handles, node wallet); `src/bip322.rs`:
  BIP-322 simple signatures.
* `src/node.rs`: `NodeRpc` over `tl-rpc-client` for the Rust-held-key mode.
* `src/config.rs`: config file.
* `scripts/build-ui.mjs`: builds `packages/wallet-fe` (configuration `tauri`) in a scratch copy
  with lifecycle scripts disabled and writes `dist-ui/` (the `frontendDist`), injecting the shim.
  With `--ref <git ref> --name <overlay>` it builds another ref (FE-speed) with `ui-overlay/<name>/`:
  overlay files (checked against a SHA-256 of the file they replace), count-checked rewrites.
* `scripts/e2e-orderbook-relay.mjs`, `scripts/soak-fe-speed.mjs`: the relay and FE-speed runs
  described below; `scripts/soak-liveness.mjs` is the 2024 master UI's soak (legacy orderbook).
* `scripts/regtest-multisig-descriptor.mjs [--chain btc|ltc]`: starts a throwaway regtest node
  (`BITCOIN_BIN` / `LITECOIN_BIN`), creates two descriptor wallets and runs the ignored cargo test
  `nodewallet::regtest_tests` (`TL_CARGO` names the cargo wrapper): both wallets sign a 2-of-2
  channel spend through `tln1:` handles, the spend is broadcast and mined. It stops the node it
  started by PID and deletes the datadir. `--chain ltc` needs a Litecoin Core with descriptor
  wallets; the official 0.21.5.8 releases are built without them.

## Configuration

`$TL_DESKTOP_CONFIG`, else `<app config dir>/config.json`
(`%APPDATA%\org.tradelayer.desktop\config.json` on Windows):

```json
{ "network": "LTCTEST",
  "node_url": "http://127.0.0.1:19332",
  "rpc_cookie_file": "C:/path/to/.cookie",
  "node_data_dir": "C:/Users/<you>/AppData/Roaming/Litecoin",
  "relayer_hosts": [],
  "orderbook_urls": ["ws://172.81.181.19:3001"] }
```

`node_data_dir` (default `%APPDATA%\Litecoin`) is the only directory the legacy UI may read
`litecoin.conf` from or create it in. `network`, `node_url` and the RPC credentials
(`rpc_cookie_file` or `rpc_user` + `rpc_password`) configure the Rust-held-key mode; `data_dir`
holds its vaults, one per network id. `relayer_hosts` lists the hosts the UI may name as its
relayer API (default none). `orderbook_urls` lists the exact orderbook origins the relay may
connect to (`ws://host:port` or `wss://host`, `http`/`https` spellings accepted as the same origin; at most 16; default
FE-speed's `ENDPOINTS` orderbook, `ws://172.81.181.19:3001`; `[]` turns the relay off). `tl_listener_url` (default `http://127.0.0.1:3000`; an `http` or
`https` loopback origin, nothing else) is the TradeLayer listener behind the FE-speed UI's `/tl/*` and
`/tlraw/*` routes and the `tradelayer/sync-status` report. `tl_rpc_via_listener` (default `true`, the shipped
UI is FE-speed) makes `rpc-call` of `tl_*` methods answer as FE-speed's wallet-server does (seven local payload
encoders, the rest through the listener) and makes the transaction builder write FE-speed's text payloads
(`tl4...`) as one `createrawtransaction` data output with the 0.0000546 dust minimum and the local node's
`listunspent`, so a plain Bitcoin Core node works; set `false` for the 2024 UI, which sends `tl_*` to the node
and builds hex payloads.

## Running tradelayer-listenerd

TradeLayer-Rust's `tradelayer-listenerd` (`9b586a0`, `docs/LISTENERD.md`) replaces the Node
`tradelayer.js` listener on `:3000`: it serves the legacy listener routes over one restored store on
loopback (`authenticated_admission:false`, no live chain ingest). FE-speed's UI runs against it with
`tl_listener_url` alone; `docs/listener-map.md` has the per-endpoint table (14 of FE-speed's 30
listener endpoints answer with data, 15 answer typed 503) and the shape mappings in
`src/legacy/listenerd.rs`.

Start it yourself and keep the default engine:

```bat
tradelayer-listenerd --demo-seed C:\tl\demo
tradelayer-listenerd --root C:\tl\demo --bind 127.0.0.1:3000 --expected-head <expectedHead printed by the seed> ^
  --config C:\tl\demo\listenerd.conf --stop-file C:\tl\demo.stop
:: config.json: { "tl_listener_url": "http://127.0.0.1:3000" }
type nul > C:\tl\demo.stop
```

Or let the app run it. `tl_engine = "tradelayer-listenerd"` plus a `tl_listenerd` object starts the
daemon with the app and stops it with the app:

```json
{ "network": "BTCREGTEST",
  "node_url": "http://127.0.0.1:18443",
  "rpc_cookie_file": "C:/path/to/.cookie",
  "tl_listener_url": "http://127.0.0.1:3000",
  "tl_engine": "tradelayer-listenerd",
  "tl_listenerd": {
    "cmd": "C:/tl/tradelayer-listenerd.exe",
    "root": "C:/tl/store",
    "expected_head": "5:4:64656d6f00000000000000040000000000000000000000000000000000000000:865460d34f4f361d69f9674dd3ad22f6f37bca0bd835557ec9b2581adf6f2777",
    "config": "C:/tl/store/listenerd.conf",
    "stop_file": "C:/tl/listenerd.stop",
    "timeout_ms": 2000,
    "stop_grace_ms": 5000 } }
```

* `cmd`, `root`, `config`, `stop_file` are absolute paths; `expected_head` is the
  `SEQUENCE:HEIGHT:HASH:COMMITMENT` token `--demo-seed` and `tl_observe` print (the daemon refuses a store
  whose head differs). `timeout_ms` (1..=60000, optional) is `--timeout-ms`; `stop_grace_ms`
  (100..=60000, default 5000) is the wait described below.
* `--bind` is the `tl_listener_url` authority, which must be `http` with a loopback IP literal
  (`127.0.0.1`, `[::1]`): the daemon takes nothing else, so `localhost` is a config error.
* Without `tl_listenerd` nothing is started and `tl_engine = "tradelayer-listenerd"` only selects the
  passthrough (the `tl_engine_url`, `tl_engine_cmd` and `tl_engine_args` fields belong to the rpcd engine
  and are refused here).
* The sidecar (`src/engine_sidecar.rs`) removes a stale stop file before each start (the daemon refuses to
  start with one), restarts the daemon with backoff when it dies, and stops it on exit by creating the stop file,
  waiting `stop_grace_ms` for exit code 0, and killing it only if it is still running. A daemon stopped by someone else creating
  the stop file stays down.

## Running tradelayer-node

TradeLayer-Rust's `tradelayer-node` (`docs/NODE.md`) is the live counterpart of the daemon: one process that
follows a Bitcoin Core node, authenticates the TradeLayer candidates of each new block, applies them to its
durable economic chain, rolls back on a reorg, and serves the same legacy listener routes on a loopback bind.
FE-speed's UI runs against it exactly as against `tradelayer-listenerd`.

* BTC only: `network` is `BTC` (mainnet addresses) or `BTC-TESTNET4`; Litecoin is not offered.
* `authenticated_admission` in `tl_initmain` / `GET /initstatus` is `false` until the running node has applied
  a block it admitted, and then describes that tip: the sender is the address of the parent output of
  input 0 (P2PKH or P2WPKH, SIGHASH_ALL), proven by signature, and the candidate is proven included in the
  block. Other inputs, parent unspentness and full Bitcoin consensus are not proven; Core's active chain is
  taken as given. `docs/NODE.md` has the exact scope.
* Create the store once on the command line (`tradelayer-node --initialize ...`, optionally with
  `--anchor-height` / `--anchor-hash`); the app only restarts an existing store. `--initialize`, the anchor
  flags and `--max-blocks` are not config fields.
* The anchor is the economy's base tip, and the rules see absolute Bitcoin heights from it (TradeLayer-Rust
  e010b64). On `BTC-TESTNET4`, initialize with an anchor above height 0, at a recent testnet4 block: at
  height 0 the economy's anchor is the mainnet genesis. The anchor is part of the store's config identity,
  so a store initialized before e010b64 is refused on load and has to be initialized again.
* End to end: `node scripts/e2e-node-sidecar.mjs <tl-desktop.exe> <tradelayer-node.exe>` against a synced
  Bitcoin Core testnet4 node (cookie auth, RPC on `127.0.0.1:48332` by default). It initializes a store 12
  blocks below Core's tip, starts the app with the node as its sidecar, and requires the node to reach the tip
  with `authenticated_admission:true`, `/tlraw/tl_getMaxProcessedHeight` to equal Core's absolute tip height,
  `rpc-call` of `tl_check_kyc` / `tl_check_commits` to be answered by the node, the node to exit on its stop
  file when the window closes, and the store to restart cleanly. Run 2026-11-06 with TradeLayer-Rust
  0.1.0-rc.2 (22ad645) at testnet4 height 159,367: E2E_NODE_SIDECAR_OK.

```json
{ "network": "BTC",
  "node_url": "http://127.0.0.1:8332",
  "rpc_cookie_file": "C:/path/to/.cookie",
  "tl_listener_url": "http://127.0.0.1:3000",
  "tl_engine": "tradelayer-node",
  "tl_node": {
    "cmd": "C:/tl/tradelayer-node.exe",
    "root": "C:/tl/node",
    "network": "BTC",
    "rpc_address": "127.0.0.1:8332",
    "cookie_file": "C:/path/to/.cookie",
    "config": "C:/tl/node/listenerd.conf",
    "source_config": "C:/tl/node/source.conf",
    "head_log": "C:/tl/node/observer.head",
    "stop_file": "C:/tl/node.stop",
    "rpc_timeout_ms": 10000,
    "stop_grace_ms": 10000 } }
```

* `cmd`, `root`, `config`, `source_config`, `head_log`, `stop_file` are absolute paths, as are the optional
  `cookie_file` (Core's cookie for the node's `--rpc-address`) and `economic_head_log`. `rpc_address` is a
  literal `IP:PORT` (not a host name, port not 0). `resume` (optional, `--resume`) clears a paused or
  quarantined observer at start. `timeout_ms` and `rpc_timeout_ms` (1..=60000, optional) are
  `--timeout-ms` and `--rpc-timeout-ms`; `stop_grace_ms` (100..=60000, default 5000) is the stop wait.
* Without `cookie_file` the node reads `RPC_USER` and `RPC_PASS` from its environment, which it inherits from
  the app. tl-desktop never reads, passes on the command line or logs them.
* `--bind` is the `tl_listener_url` authority, `http` with a loopback IP literal as for the daemon.
* Without `tl_node` nothing is started and `tl_engine = "tradelayer-node"` only selects the passthrough. The
  `tl_engine_*` fields and `tl_listenerd` are refused with this engine, and `tl_node` with any other.
* The sidecar is the daemon's (`src/engine_sidecar.rs`): stale stop file removed before each start, restart
  with backoff, stop through the stop file with the grace wait, and a node stopped by someone else creating the
  stop file stays down. The node's JSON lines go to its standard output, which the sidecar discards; its last
  standard-error line is kept.

Not run against a live node by this crate: the tests cover the arguments, the rejections and the stop-file
shutdown with a stand-in child process.

Integration test against a running daemon on a demo store (30+ bridge calls):

```bat
set TL_LISTENERD_URL=http://127.0.0.1:3000
build-desktop.cmd test --locked -- --ignored real_listenerd
```

Run of 2026-11-05 (Windows 11, TradeLayer-Rust `9b586a0` built from a `git archive` export, Rust 1.90.0, demo store
from `--demo-seed`: head 5:4, DemoAlice long 2 on contract 1):

* `real_listenerd_serves_fe_speeds_routes_through_the_tlapi_bridge`: 1 passed, 30+ calls through the bridge.
* The default exe with the sidecar config above (`TL_DESKTOP_CONFIG`): the app started the daemon, the UI
  bootstrapped (`RENDER_OK`, no exceptions), and a CDP probe in the page called the listener routes through
  `tlapi` and passed 16 of 16 shape checks (balance numbers add up, properties carry `id`, position numbers,
  `listenerReachable`, the `tl_getSyncStatus` fallback, typed 503s). A probe panel in the screenshot
  shows DemoAlice's balances (99,899.85 tUSD owned, 79,899.85 available, 20,000 margin) and her position.
* Not rendered by the UI itself: Portfolio and the market lists need a node and wallet addresses of the
  UI's own, and the demo addresses are not those; the market list comes from the orderbook, not the listener.
* A stop file created by hand stopped the daemon with exit 0 (`{"event":"stopped",...}`). A hard kill of
  the app does not run the exit hook, so the daemon keeps serving until its stop file is created, as the rpcd
  sidecar notes for rpcd.

## Commands and results (2026-11-02/03, Windows 11, MSVC 14.44, Rust 1.90.0, Node 24.19)

```bat
node scripts\build-ui.mjs                            :: UI_BUILD_OK (Angular build ~5 min)
call "...\VC\Auxiliary\Build\vcvars64.bat"
cd rust\tl-desktop
cargo test --locked                                  :: 80 passed, 1 ignored
cargo clippy --locked --all-targets -- -D warnings   :: clean
cargo fmt --all -- --check                           :: clean
cargo build --locked
node scripts\e2e-legacy-ui.mjs <target>\debug\tl-desktop.exe <out>   :: E2E_LEGACY_OK
```

`scripts/e2e-legacy-ui.mjs` starts a throwaway Bitcoin Core 31.1 `-regtest` node with synthetic
credentials, writes a `litecoin.conf` for it into a temporary `node_data_dir`, launches the app
with WebView2 remote debugging and drives the original UI:

1. "Select Network" renders, and there is no "No connection with local server" banner (the
   socket.io session is open).
2. Start Node connects to the regtest node, and a page `rpc-call` for `getblockchaininfo` returns
   chain `regtest`.
3. From the page: `dumpprivkey` answers a `tln1:` handle and never reaches the node;
   `keys/get-address` answers a `tlk1:` handle and an empty `privkey`; `fetch` to an arbitrary host
   is blocked by CSP.
4. After 3 blocks are mined, the UI shows "Full Synchronized 8 / 8", "SYNCED" and "Block: 8"
   through `new-block`.
5. The page throws no uncaught exceptions.

`scripts/e2e-orderbook-relay.mjs <exe> <orderbook origin>` exercises the WebSocket relay against a
running `tl-orderbook-server` (branch `auth`, see "FE-speed against the optimized orderbook server"
below), from the page origin over the same `tlapi` socket.io endpoint the Angular `SocketService`
uses. The page's own UI socket would take the single current session back, so the script fails the
UI's socket.io XHRs and speaks to the endpoint with `fetch`. A direct WebSocket client that sends
`x-tradelayer-client: desktop` (honoured by the scratch export only) places the orders. It printed
`E2E_RELAY_OK`, covering:

* a URL outside `orderbook_urls`, and a path other than `/` or `/ws`, get `OB_SOCKET::connect_error`
  without the server being contacted;
* `ob-sockets-connect` gets `OB_SOCKET::connect` with payload `{}` and then `OB_SOCKET::connected`
  with the server's hello (`clientClass: web`, `authRequired: true`);
* `update-orderbook` and `orderbook:join` get `OB_SOCKET::orderbook-data` (the whole flat message);
* the relay's own `new-order` and `close-order` get the server's `order:error`
  ("Authentication required (web client)...") as `OB_SOCKET::order:error`;
* an order placed by the direct client shows up in the relay session's book, and a fresh snapshot
  no longer holds it after the direct client cancels it;
* `ob-sockets-disconnect` gets `OB_SOCKET::disconnect`.

The ignored unit test `obrelay::tests::real_orderbook_server_round_trip` (`TL_OB_URL=ws://127.0.0.1:3001`)
passed against the same server.

The scripts below that drive the 2024 master UI (`e2e-trading-ui.mjs`, `e2e-swap-ui.mjs`,
`soak-liveness.mjs`) were written for the legacy socket.io `tl-orderbook-server` and its polling
relay. The relay now speaks the WebSocket protocol only, so they no longer connect to a legacy
server; their results below are the runs made with the polling relay (git history before the
WebSocket relay commit).

`scripts/e2e-trading-ui.mjs <exe> <orderbook url> <out>` drives those screens against a regtest
node and a running legacy `tl-orderbook-server`. The exe's CSP must allow the orderbook origin,
because the market list is fetched from the page. A second trader, a direct socket.io client,
first places a SELL order of 7.77 at 0.4321 on LTC/USDT. The run printed `E2E_TRADING_OK`:

1. The menu shows Spot Trading and Futures Trading, and the node syncs (3/3).
2. The Servers tab opens the original Servers window, a custom orderbook URL is entered and
   connected through the Rust relay, and the disconnect button appears.
3. Spot Trading lists the orderbook's five spot markets, and its Order Book shows the second
   trader's order (0.4321 / 7.7700 / 3.3574).
4. Futures Trading renders, and the page throws no uncaught exceptions.
5. The UI's own Buy button stays disabled. In this snapshot `spotKeyPair` reads
   `authService.walletKeys.spot[0]`, which node-wallet mode never fills; `bd0ce5c` also commented
   out the body of Create Spot Address. Placing orders from the UI also needs a TradeLayer
   attestation (`tl_*` RPCs), which a Bitcoin Core node cannot provide.

Two more problems were found on the orderbook side:

* `/markets/spot` and `/markets/futures` on tl-orderbook-server master `909332c` throw
  `TBILL is not defined`: the 2025-08-22 commits renamed the `TBILL` token definitions to `USDT`
  but kept the `TBILL` uses. The local test peer aliases `TBILL` to `USDT`.
* Market icons are third-party image URLs supplied by the orderbook server, and the CSP
  (`img-src 'self' data:`) blocks them, so they show as broken images.

The Rust-held-key mode has its own run, `scripts/e2e-regtest.mjs`, against a build of the `ui/`
surface with the strict CSP. Set this before `cargo build`:

```bat
set TAURI_CONFIG={"build":{"frontendDist":"ui"},"app":{"withGlobalTauri":true,"security":{"csp":"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'","dangerousDisableAssetCspModification":false,"freezePrototype":true}}}
```

The run printed `E2E_OK` and covers:

* create, fund, balance and preview;
* sign and broadcast, with the node's fee equal to the previewed fee (459 sat, 141 vB);
* negative IPC probes and CSP probes;
* lock/unlock, and a restart that opens locked.

## FE-speed against the optimized orderbook server (2026-11-04/05)

The FE-speed UI (`origin/FE-speed` @ `3f4a67c`) runs in this shell against the current
`tl-orderbook-server` (branch `auth` @ `25c0f82`: HyperExpress/uWebSockets, one raw WebSocket per
client, optimized order matching and topic fan-out).

Build and run:

```bat
node scripts\build-ui.mjs --ref origin/FE-speed --name fe-speed <work dir>   :: dist-ui-fe-speed/
:: a test exe on that UI; the market list is fetched by the page from the orderbook's http origin
set TAURI_CONFIG={"build":{"frontendDist":"dist-ui-fe-speed"},"app":{"security":{"csp":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src ipc: http://ipc.localhost http://tlapi.localhost http://172.81.181.19:3001 http://127.0.0.1:3001 ws://127.0.0.1:3001 http://172.81.181.19:8191 http://172.81.181.19:9191; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"}}}
cargo build --locked
```

The orderbook link goes through Rust (`obrelay.rs`), so the `ws://` entry in `connect-src` is not
needed by the page; the `http://` entry is (`/markets/spot|futures/<network>`). Add the orderbook to
`orderbook_urls` in the desktop config. In the UI's Servers window the custom orderbook entry takes
`ws://host:3001/ws`.

What the server allows a relay client. The server's `handleOpen(ws)` gets no upgrade request
(`srv.ws('/ws', ws => socketManager.handleOpen(ws))`), so `detectClientClass` always answers
`web`, whatever headers a client sends; the `desktop` and `bot` classes (exempt from session auth) are
dead code there. A `web` client gets `{"event":"connected","id":..,"clientClass":"web","authRequired":true}`
and may read: `update-orderbook` and `orderbook:join` are answered with `orderbook-data`, and
subscribers of a market get its coalesced `orderbook-data` pushes. `new-order`, `many-orders`,
`amend-order` and `close-order` are answered with `order:error`
"Authentication required (web client). Send { event: "auth", token } first." The `auth` event takes a
session token from `getSessionForToken`, but the `/auth` routes that issue one do not build
(`routes/auth.route.ts` imports a missing `../crypto/bip322` and is a Fastify plugin mounted on
HyperExpress), so no client can authenticate on the committed branch. The relay therefore does not
treat `authRequired` as an error: it connects, relays the hello as `OB_SOCKET::connected`, and the
server's `order:error` for a mutation reaches the UI as `OB_SOCKET::order:error` (the UI toasts it
as an orderbook error). The relay passes `auth` through if a future UI sends one. The scratch export
used for the runs below (`make_export.sh`) adds an upgrade passthrough so the headers are read; only
the test's direct client uses it, the relay sends no class header and works unchanged without it.

Runs (Windows 11, WebView2, Bitcoin Core 31.1 regtest, the server in WSL on `127.0.0.1:3001`):

* `scripts/e2e-orderbook-relay.mjs`: `E2E_RELAY_OK`, 14 checks, see above.
* `SOAK_BASELINE_ONLY=1 scripts/soak-fe-speed.mjs <exe> ws://127.0.0.1:3001 1`: `E2E_FE_SPEED_OK`.
  Select Network, Start Node (synced, 3 blocks), Servers window connected to `ws://127.0.0.1:3001/ws`,
  Spot Trading on TLTC/USDTt. A direct WebSocket client (class `desktop` through the upgrade header)
  places orders with `many-orders`; the server answers the market's subscribers with
  `update-orders-request`, the UI asks for a snapshot, and the Order Book card shows 1500, 1501,
  1502 and 1503 (screenshot `work/fe-speed-ob-shots/fe-speed-orderbook.png`).
* `scripts/soak-fe-speed.mjs <exe> ws://127.0.0.1:3001 20` (20 minutes, scaled from the 45-minute
  plan): `SOAK_OK`. Disruptions: minimize 67 s, freeze 67 s, orderbook server stopped for 10 s and
  started again, minimize+freeze 80 s, minimize 80 s, freeze 80 s, minimize 160 s. After each one the
  main socket, the orderbook link, the block counter and the order book view (an order placed at the
  moment of resume) were current again within 30 s; the recoveries took 1.1, 1.4, 2.4, 22.1, 3.0, 4.4
  and 10.4 s, and 1.5 s at the end. The server restart took the placer's orders with it; the UI's
  link reconnected, joined its market again on the hello and showed the placer's new order 2.4 s after
  the server answered. 37 mined blocks were followed by the UI counter (median 4.9 s, max 5.3 s: the
  5 s `getblockchaininfo` probe), 24 live orders were shown in the order book view (median 0.3 s,
  max 0.4 s), the 100 ms page timer kept 98 to 100 % of its rate while minimized, memory slope
  -2.7 MB/min (working-set trimming of the hidden page), no uncaught page exceptions.

Two protocol points of the server and FE-speed that the relay does not paper over:

* The server's market broadcasts (`orderbook-data` to the topic) carry `symbol: "0-5-LTCTEST"` and
  no `marketKey`; FE-speed's spot orderbook service compares the message's `marketKey` with its
  active key `0-5` and drops them. The UI's book updates come from snapshots (`update-orderbook` and
  `orderbook:join` answers, which carry `marketKey: "0-5"`), which it requests on every
  `update-orders-request` (sent for `many-orders`, `amend-order` and matches). A plain `new-order` by
  another client does not refresh a UI that is already on the market until the next request.
* `close-order` is answered to the canceller only (no market broadcast), so other clients see the
  cancel at their next snapshot.

## FE-speed two-party swap (2026-11-05)

`scripts/e2e-swap-fe-speed.mjs <exe> <orderbook origin> <out dir>` drives two instances of the default
build (FE-speed with the chrome skin) through a spot swap on two peered Bitcoin Core 31.1 regtest nodes
with descriptor wallets and a local `tl-orderbook-server` (branch `auth`, BIP-322 login enforced):
Select Network, Start Node, the Servers window connects the orderbook, Portfolio creates the spot
address (`getnewaddress` in the `tl-wallet` node wallet the UI creates itself; the wallet-encryption
prompt is cancelled), the miner funds both addresses (coinbase plus 101 blocks to a `raw(51)` burn
script) and keeps running, the seller places a SELL and the buyer the matching BUY on TLt/USDTt
(properties 1 and 5). It then checks the chain: both commit transactions (`tl4...`) pay the same sorted
2-of-2 P2WSH channel multisig from the two traders' addresses, the trade transaction (`tlk...`) spends
the channel output with two signatures from the two node wallets (`tln1:` handles, PSBT) and is mined,
both UIs toast the completion, and no "Trade Error" or `TERMINATE_TRADE` appears, also after the
swapper's 60 s timer (`SWAP_LATE_S`). Each trader gets its own `tl-listener-double.mjs` as
`tl_listener_url`; the nodes need no TradeLayer methods because the FE-speed builder (see
`tl_rpc_via_listener`) uses plain `createrawtransaction`.

```bat
:: build the exe: default UI, CSP with the local orderbook
node scripts\skin-csp.mjs "<csp of tauri.conf.json>" --dist dist-ui-fe-speed-skin --connect http://127.0.0.1:3001 --connect ws://127.0.0.1:3001
:: -> set TAURI_CONFIG to the printed JSON, then: cargo build --locked
:: orderbook: tl-orderbook-server @ 8af3556, WSL node 24:  TL_OB_BIND=127.0.0.1 TL_OB_WSS_PORT=0 TL_OB_WS_PORT=3001 node dist/index.js
node scripts\e2e-swap-fe-speed.mjs <exe> ws://127.0.0.1:3001 <out dir>
node --test scripts\tl-listener-double.test.mjs
```

Run of 2026-11-05 (Windows 11, WebView2, Bitcoin Core 31.1 regtest, orderbook on `127.0.0.1:3017`):
`E2E_SWAP_FE_SPEED_OK`, 54 checks passed, none failed. Seller commit `9322c933...` (block 107), buyer commit `50e03a0b...` and
trade `2c6b6df9c41cfcdf7b2caccb2c99376b8d107318ab0d37b44ac190bb7581c65b` (block 108, witness
`[4, 2]` items for the channel and the buyer's P2WPKH input); both UIs toasted "Trade Completed".

What the run found and fixed on the wallet side:

* `/api/compute-multisig` answered `tltc1...` for a regtest node (FE-speed selects Litecoin Testnet by
  default); a connected regtest node now decides the prefix (`bcrt` for Bitcoin Core, `rltc` for Litecoin
  Core). `nodewallet.rs` does the same for `tln1:` handle addresses.
* FE-speed's builder sends text payloads and expects no TradeLayer node: with `tl_rpc_via_listener`
  (now the default) the payload is one `createrawtransaction` data output, the dust minimum is the
  constant 0.0000546 and `listunspent` asks the local node. Payload transactions carry sequence
  `0xfffffffe` (FE-speed's seller aborts on an RBF commit; Core 24+ makes inputs replaceable).
* `getblockcount` joined the `rpc-call` allowlist (the buyer's step 3 reads it).
* Overlay rewrites (`ui-overlay/fe-speed/rewrites.json`): commit output lookup by
  `scriptPubKey.address`, buyer settles its ready promise and checks the final broadcast, the 60 s
  whole-trade timer is cleared when the promise settles.

Open items in other components, not patched here:

* Relay login (`authsign.rs`) parses the address with the UI's network label too, so on a regtest
  node every login fails with `signing failed: address: InvalidAddress("base58check")`. The same
  regtest override as in `nodewallet.rs::chain_network` fixes it; the run above used that change in a
  scratch copy of `authsign.rs` only.
* tl-orderbook-server `channel-swap.class.js` builds the client-to-dealer swap event with
  `{...raw.data, tradeUUID}`: a string `data` (the buyer's `BUYER:STEP6` txid and a `TERMINATE_TRADE`
  reason) reaches the seller as `{"0":"c","1":"c",...}` (toast "[object Object] Trade Completed").
* The server's matched-trade `props` pair the amounts with the wrong property ids
  (`manager_class.js` around line 754: `amountDesired = quantity * price`, `amountForSale = quantity`,
  while `id_desired` is the base property), so the swappers commit 0.5 of the base and 1 of the quote for
  an order of 1 at 0.5, and the trade payload reads `tlk5,1,...`: the buyer offers 1 USDT for 0.5 TL.
* FE-speed's swapper (not patched): `buyer.ts` computes `utxoData` for its own commit and never uses
  it; the constructor and `SwapService` both call `onReady()`; `seller.ts` step 2 has its `try` commented
  out, so an error there is an unhandled rejection and not a `terminateTrade`; the completion sound
  throws `NotAllowedError` without a user gesture.

## Orderbook login

`tl-orderbook-server` (branch `auth`) refuses a `web` client's `new-order`, `many-orders`,
`amend-order` and `close-order` until the address they trade for has logged in. The relay does that
for the UI (`src/obauth.rs`):

1. `GET <origin>/auth/challenge` answers `{nonce, message, expiresAt}`. The HTTP origin is the
   WebSocket origin (`ws` to `http`, `wss` to `https`, same host and port), so `orderbook_urls`
   covers it; there are no redirects and no proxy, and every call times out after 5 s.
2. The address signs `message` (`src/authsign.rs`, on the `legacy` thread that owns the keys and
   the node connection):
   * a `tlk1:` key (P2SH-P2WPKH) signs BIP-322 simple in Rust (`src/bip322.rs`);
   * a node-wallet address (P2WPKH, P2SH-P2WPKH or P2TR) gets the BIP-322 `to_sign` PSBT
     (`witness_utxo` is the virtual output, plus the BIP-32 origin from `getaddressinfo` and the
     redeem script of a P2SH address) and the node signs it with `walletprocesspsbt`; the
     signature is the finalized input's witness. A P2PKH address is signed by the node's
     `signmessage` (BIP-137). An address that is neither in the key table nor `ismine` in the node
     wallet is refused. The node is reached through a second handle on the connection the service
     holds, so no method is added to the page's `rpc-call` allowlist.
3. `POST <origin>/auth/verify` `{address, message, signature}` answers `{token, expiresAt}` (the
   older `sessionToken` name is accepted), then the relay sends `{event: "auth", token}` and the
   server answers `auth_ok {address, expiresAt}`. A socket may authenticate several addresses.

Which addresses: the ones the UI trades with, read from its own `new-order` and `many-orders`
payloads (`keypair.address`, `address`, `order.keypair.address`, `order.address`, with `network`
from the payload or the last one the UI named). `close-order` and `amend-order` carry no address
and use the connection's active one. The key-handle table and the node wallet decide whether the
relay can sign for an address at all. An event whose address is not logged in waits in a queue of
at most 16 (in order, 15 s), the login runs on a worker thread (at most 8 at once), and the event
is forwarded on `auth_ok`. A failure reaches the UI as `OB_SOCKET::order:error` ("Orderbook login
failed: ..."), and the address is not tried again for 5 s.

Tokens are held only inside the login worker and for the instant of the `auth` frame; they are not
stored, logged or sent to the page, and token fields are stripped from server messages. A login
is renewed at 80 % of its lifetime (the server's `expiresAt`, 10 minutes). After a lost
connection, a hand-over to a new relay client or a resume from sleep, the client logs its known
addresses in again as soon as the new hello arrives. `/api/logout`, `/keys/logout` and
`stop-wallet-node` make every client forget its addresses and queued events. A server whose hello
does not say `authRequired: true` gets everything unchanged.

Tests (`cargo test --locked`, Windows MSVC 14.44, Rust 1.90.0):

* `bip322`: the BIP-322 test vectors (message hashes, `to_spend`/`to_sign` ids, and both simple
  signatures of the P2WPKH vector reproduced byte for byte and verified), P2SH-P2WPKH, tampering.
* `obauth`: the state machine with an injected clock (renewal at 80 %, queue and login timeouts,
  cooldown, bounds, reconnect and seed, logout, ordering, many-orders, `close-order`), and the
  login worker against a mock HTTP server (every failure has a plain reason, nothing is signed for
  a malformed challenge, the 5 s timeout, the worker bound).
* `authsign`: the `tlk1` path, the node paths against a scripted node, the tap, the job queue.
* `obrelay` (`include!`d `obrelay_auth_tests.rs`): a mock orderbook with the WebSocket and the
  `/auth` routes on one port; the order is held until `auth_ok` and then forwarded, a failed
  login reaches the UI, no login for a server that needs none, re-login after a reconnect and
  after `Resume`, renewal before expiry, logout, and no token in anything the UI receives.
* `legacy`: a sign job and a logout through the bridge's `legacy` thread.
* Ignored: `authsign::tests::regtest_node_wallet_signatures_verify` (Bitcoin Core 31.1 regtest,
  throwaway datadir; the node wallet's signatures for bech32, p2sh-segwit, legacy and bech32m
  addresses verify with the Rust verifier; passed), and `real_orderbook_server_login_round_trip`
  (`TL_OB_URL`, needs the server's `/auth` routes).

## Dependencies

* `tauri`/`tauri-build` 2: the shell.
* `serde`/`serde_json`: IPC values and the config file.
* `getrandom` 0.3: the session token, mnemonics, plan ids, salts and nonces.
* `reqwest` `=0.12.24` (blocking, rustls): the legacy node and relayer clients. This is the same
  pin as `tl-rpc-client`.
* `tungstenite` `=0.30.0` (`handshake`, `rustls-tls-webpki-roots`; no tokio): the orderbook relay's
  blocking WebSocket client, `ws://` and `wss://`. It adds 9 crates to the lockfile
  (`tungstenite`, `data-encoding`, `sha1` 0.11 with `digest` 0.11, `block-buffer`, `crypto-common`,
  `const-oid`, `hybrid-array`, `webpki-roots` 0.26) and reuses `rustls` 0.23 (ring), `rand` 0.10,
  `http`, `httparse`, `bytes` and `thiserror` that Tauri and `reqwest` already bring. No existing
  package changed version.
* `tl-wallet-service` and `tl-desktop-core`: path dependencies.
* `tl-wallet-core` (TL-Extension) and `tl-rpc-client` (tl-rpc): pinned to pushed git revisions.

The lockfile holds about 400 packages, almost all from Tauri.

## Gaps

* **Placing orders from the UI:** the relay now logs addresses in by itself (see "Orderbook
  login"); the screens and the orderbook are live, but the snapshot's
  buy/sell cards still read the pre-`bd0ce5c` key list and need a TradeLayer attestation, so the
  UI cannot place an order yet. Finishing the node-wallet migration of those cards is upstream
  wallet-fe work.
* **Untested against the hosted orderbook:** the relay has not been run against the hosted
  orderbook servers or through a real two-party swap.
* **TradeLayer RPCs** (`tl_*`) were not exercised. The regtest node is Bitcoin Core, and no
  TradeLayer-enabled Litecoin node is available here.
* **Remote calls:**
  * The UI's direct relayer calls (`relayer-api.service.ts`) go to the configured plain-http
    endpoints, as in legacy.
  * The Rust relayer client accepts https only.
  * A custom server typed into the UI is blocked by CSP until it is added to `tauri.conf.json`.
* **Fonts:** Roboto and Material Icons load from Google at startup, as in legacy. Vendoring them
  would remove that request.
* **Not wired yet:**
  * The installer is NSIS, per-user (`bundle.targets`, `installMode: currentUser`); CI builds it with
    `cargo tauri build --bundles nsis` and uploads it as the `tl-desktop-installer` artifact. It is unsigned:
    no code-signing certificate is configured, so SmartScreen warns on first run. There is no auto-updater.
  * `withGlobalTauri` is off: the FE-speed UI talks to Rust only over `tlapi` and the orderbook relay, never
    over IPC, so `window.__TAURI__` is not exposed. The `ui/` vault test surface turns it back on through
    its `TAURI_CONFIG` override.
  * The native folder picker is not wired.
  * The Angular UI does not use the Rust-held-key mode.
* **Platforms and CI:**
  * Only built and run on Windows.
  * The CI workflow `.github/workflows/rust-tl-desktop.yml` targets `windows-2022` and has not run;
    it triggers on pull requests.
