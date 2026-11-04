# tl-desktop

The TradeLayer desktop wallet as a Tauri 2 application: a native window (WebView2 on Windows)
that runs the **original Angular wallet UI** (`packages/wallet-fe`, components, services and
templates unchanged) on a Rust backend. It replaces the Electron main process (`builder/`) and
the Node `wallet-server` (`packages/wallet-server/`).

* Toolchain: Rust 1.90.0 (`rust-toolchain.toml`), Tauri 2.12.5, committed `Cargo.lock`;
  Angular 12.1.5 built with Node 24 (`--openssl-legacy-provider`).
* Licence: ISC (as the repository `package.json`).

## How the original UI runs without Electron or Node

| Electron wallet | tl-desktop |
|---|---|
| Node `wallet-server` on `localhost:1986` (Fastify + socket.io, no authentication; see `rust/tl-wallet-service/README.md`) | No listening socket. The UI's `homeApiUrl` is `http://tlapi.localhost`, a Tauri custom URI scheme served in-process (`src/legacy.rs`) by `tl-wallet-service`, so only this webview can reach it. The bridge holds the session token itself. |
| socket.io server for the main socket, `new-block`, `core-error` | `src/socketio.rs`: Engine.IO v4 long-polling + socket.io v5 on the same scheme; `new-block`/`core-error` from a 5 s `getblockchaininfo` probe through the same gate as page calls |
| `ob-sockets.service.ts`: a raw WebSocket client (`ws`) to whatever orderbook URL the page names, relaying `OB_SOCKET::*` events, the order events and `<socketId>::swap` between the orderbook server (HyperExpress/uWebSockets, JSON text messages) and the UI's socket.io main socket | `src/obrelay.rs`: the same relay, a blocking `tungstenite` client (rustls for `wss://`) on its own threads, with the same message mapping (table in the module doc). Server→UI: the flat message `{event, ...}` becomes `OB_SOCKET::<event>` with the whole message for `connected` (the hello with the socket id), `order:error`, `order:saved`, `placed-orders`, `orderbook-data`, `update-orders-request`, `amended`, `auth_ok`, `auth_ignored`; `new-channel` and `<counterparty>::swap` are unwrapped from `msg.data`; open/close/failure become `OB_SOCKET::connect` (payload `{}`), `disconnect`, `connect_error`. UI→server: `update-orderbook`, `new-order`, `close-order`, `many-orders`, `orderbook:join`, `orderbook:leave`, `amend-order`, `auth` and `OB_SOCKET::new-channel` as flat `{event, ...payload}` (an `event` key in the payload never replaces the name); `<own id>::swap` as `{event, eventName, socketId, data}`. Only origins in `orderbook_urls` are contacted (legacy connected to any URL), the path must be `/` or `/ws`; event names outside these lists are dropped; messages and queues are bounded. The server's `desktop`/`bot` classes need an upgrade header the server does not read yet, so the relay is a `web` class client: reads work, mutations get the server's `order:error` ("Authentication required (web client)...") until the server's session flow exists |
| `rpc-call` forwards any node method, including `dumpprivkey` | `tl-wallet-service` gate method allowlist. `dumpprivkey` is never forwarded: it answers the node-wallet handle `tln1:<address>` (FE-speed posts what it gets to the sign routes). `signrawtransaction` refuses private keys in its key list. `signrawtransactionwithwallet [rawtx]`, the swapper's commit-transaction call, runs the sign guard (chain amounts, fee ceiling) before the node wallet signs |
| `keys/*` routes return mnemonic, private key and WIF to the page; `sign-tx`/`sign-psbt` take a WIF from the page | Key handles (`src/legacy/keyvault.rs`, `localsign.rs`). `keys/get-address*` derive in Rust from the mnemonic the page supplies (FE-speed shows and stores the mnemonic for backup, unchanged) and answer `{address, pubkey, privkey: "", wif: "tlk1:<128-bit id>"}`; the key stays in a bounded in-memory table (1024 keys, least recently used evicted, 12 h idle expiry, erased on drop, emptied by `/api/logout`, `/keys/logout` and `stop-wallet-node`). `sign-tx`/`sign-psbt` run the service guards, then resolve `tlk1:` to the key and sign with FE-speed's semantics, byte-identical to its `crypto.util.ts`; `tln1:<address>` and an empty `wif` go to the node wallet (a `tln1:` handle only for inputs of that address); a real WIF is refused |
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
* `src/node.rs`: `NodeRpc` over `tl-rpc-client` for the Rust-held-key mode.
* `src/config.rs`: config file.
* `scripts/build-ui.mjs`: builds `packages/wallet-fe` (configuration `tauri`) in a scratch copy
  with lifecycle scripts disabled and writes `dist-ui/` (the `frontendDist`), injecting the shim.
  With `--ref <git ref> --name <overlay>` it builds another ref (FE-speed) with `ui-overlay/<name>/`:
  overlay files (checked against a SHA-256 of the file they replace), count-checked rewrites.
* `scripts/e2e-orderbook-relay.mjs`, `scripts/soak-fe-speed.mjs`: the relay and FE-speed runs
  described below; `scripts/soak-liveness.mjs` is the 2024 master UI's soak (legacy orderbook).

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
`/tlraw/*` routes and the `tradelayer/sync-status` report. `tl_rpc_via_listener` (default `false`) makes
`rpc-call` of `tl_*` methods answer as FE-speed's wallet-server does (seven local payload encoders, the rest
through the listener); leave it off for the 2024 UI, which sends them to the node.

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
set TAURI_CONFIG={"build":{"frontendDist":"ui"},"app":{"security":{"csp":"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'","dangerousDisableAssetCspModification":false,"freezePrototype":true}}}
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

* **Placing orders from the UI:** the screens and the orderbook are live, but the snapshot's
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
  * There is no auto-updater, installer or code signing (`bundle.active` is false).
  * The native folder picker is not wired.
  * The Angular UI does not use the Rust-held-key mode.
* **Platforms and CI:**
  * Only built and run on Windows.
  * The CI workflow `.github/workflows/rust-tl-desktop.yml` targets `windows-2022` and has not run;
    it triggers on pull requests.
