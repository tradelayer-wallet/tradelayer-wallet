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
| socket.io server for the main socket, `new-block`, `core-error` and the orderbook relay | `src/socketio.rs`: Engine.IO v4 long-polling + socket.io v5 on the same scheme; `new-block`/`core-error` from a 5 s `getblockchaininfo` probe through the same gate as page calls |
| `rpc-call` forwards any node method, including `dumpprivkey` | `tl-wallet-service` gate method allowlist (`dumpprivkey` answers 403) |
| `keys/*` routes return mnemonic, private key and WIF to the page; `sign-tx`/`sign-psbt` take a WIF from the page | Refused in the desktop build. This wallet-fe snapshot is a node-wallet UI (addresses from `getaddressesbylabel`, `getWifByAddress` returns `''`), so the UI does not use them |
| Electron main process: `window.require('electron')` IPC for the folder picker and auto-updater | `ui-shim/electron-shim.js`, loaded before the bundles, provides the `ipcRenderer` the UI calls. `check-version` is answered with the updater's "up to date" state (no auto-updater in this build); folder picker and download are dropped (the dialog keeps its text field) |
| Chromium with Node integration | WebView with CSP: `script-src 'self'` (no inline script, no eval); inline styles allowed (Angular injects component styles); fonts from Google Fonts as in the legacy `index.html`; `connect-src` limited to IPC, `tlapi` and the four relayer/orderbook endpoints in `environment.ENDPOINTS`. The capability list is empty: no Tauri core or plugin command (fs, shell, http, event) is granted. |

`freezePrototype` is off: zone.js and crypto-js in the legacy bundle assign `Object.prototype`
members and fail on a frozen prototype.

The UI build adds only an `angular.json` configuration `tauri` and `environment.tauri.ts`
(`homeApiUrl`, critical-CSS and font inlining off so no inline event handler is emitted).

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
* `src/node.rs`: `NodeRpc` over `tl-rpc-client` for the Rust-held-key mode.
* `src/config.rs`: config file.
* `scripts/build-ui.mjs`: builds `packages/wallet-fe` (configuration `tauri`) in a scratch copy
  with lifecycle scripts disabled and writes `dist-ui/` (the `frontendDist`), injecting the shim.

## Configuration

`$TL_DESKTOP_CONFIG`, else `<app config dir>/config.json`
(`%APPDATA%\org.tradelayer.desktop\config.json` on Windows):

```json
{ "network": "LTCTEST",
  "node_url": "http://127.0.0.1:19332",
  "rpc_cookie_file": "C:/path/to/.cookie",
  "node_data_dir": "C:/Users/<you>/AppData/Roaming/Litecoin",
  "relayer_hosts": [] }
```

`node_data_dir` (default `%APPDATA%\Litecoin`) is the only directory the legacy UI may read
`litecoin.conf` from or create it in. `network`, `node_url` and the RPC credentials
(`rpc_cookie_file` or `rpc_user` + `rpc_password`) configure the Rust-held-key mode; `data_dir`
holds its vaults, one per network id. `relayer_hosts` lists the hosts the UI may name as its
relayer API (default none).

## Commands and results (2026-11-02/03, Windows 11, MSVC 14.44, Rust 1.90.0, Node 24.19)

```bat
node scripts\build-ui.mjs                            :: UI_BUILD_OK (Angular build ~5 min)
call "...\VC\Auxiliary\Build\vcvars64.bat"
cd rust\tl-desktop
cargo test --locked                                  :: 58 passed
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
3. From the page: `dumpprivkey` gets 403 from the gate; `keys/new-wallet` is refused with no
   mnemonic; `fetch` to an arbitrary host is blocked by CSP.
4. After 3 blocks are mined, the UI shows "Full Synchronized 8 / 8", "SYNCED" and "Block: 8"
   through `new-block`.
5. The page throws no uncaught exceptions.

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

## Dependencies

* `tauri`/`tauri-build` 2: the shell.
* `serde`/`serde_json`: IPC values and the config file.
* `getrandom` 0.3: the session token, mnemonics, plan ids, salts and nonces.
* `reqwest` `=0.12.24` (blocking, rustls): the legacy node and relayer clients. This is the same
  pin as `tl-rpc-client`.
* `tl-wallet-service` and `tl-desktop-core`: path dependencies.
* `tl-wallet-core` (TL-Extension) and `tl-rpc-client` (tl-rpc): pinned to pushed git revisions.

The lockfile holds about 400 packages, almost all from Tauri.

## Gaps

* **Orderbook relay:** `ob-sockets-connect` answers `OB_SOCKET::connect_error`, so the UI shows
  the orderbook as disconnected. Spot and futures trading need a socket.io client in Rust that
  relays the remote orderbook.
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
