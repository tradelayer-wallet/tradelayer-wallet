# tl-desktop

The TradeLayer desktop wallet as a Tauri 2 application: a native window (WebView2 on Windows)
over [`tl-desktop-core`](../tl-desktop-core). It replaces the Electron + Node arrangement in
`builder/` and `packages/wallet-server/`.

* Toolchain: Rust 1.90.0 (`rust-toolchain.toml`), Tauri 2.12.5, committed `Cargo.lock`.
* Licence: ISC (as the repository `package.json`).

## What changes against the Electron wallet

| Electron wallet | tl-desktop |
|---|---|
| Node `wallet-server` listens on a localhost port (Fastify + socket.io, no authentication; see `rust/tl-wallet-service/README.md`) and the renderer talks HTTP to it | No listening socket. The UI calls Rust commands over Tauri IPC |
| `rpc-call` forwards any node method, including `dumpprivkey` | The node adapter (`src/node.rs`) has exactly four calls: `getblockchaininfo`, `scantxoutset`, `estimatesmartfee`, `sendrawtransaction` |
| Keys and signing in the Node process; signing trusts caller-supplied amounts | Keys live only on the wallet thread in Rust; a send is previewed first, and only `confirm_send` grants the one-use signing capability bound to the previewed inputs, outputs and fee |
| Node process + Chromium + Node integration | WebView with a strict CSP (`script-src 'self'`, no inline script, no eval, `connect-src` IPC only), prototype freezing, and an empty capability list: no Tauri core or plugin command (fs, shell, http, event) is granted |
| Network inferred from settings strings | `network` named in the config file and checked against the node's chain before every scan and broadcast |

## Layout

* `src/main.rs`: commands (`status`, `create_wallet`, `import_wallet`, `unlock`, `lock`,
  `receive_address`, `balance`, `prepare_send`, `confirm_send`, `cancel_send`). The wallet is
  owned by one thread; commands are messages to it (the RPC client blocks on its own runtime).
  A session idle longer than `idle_lock_minutes` (default 10) is locked before the next command.
* `src/node.rs`: `NodeRpc` over `tl-rpc-client` (`NodeCall` API). JSON coin amounts are
  converted to satoshis exactly or rejected.
* `src/config.rs`: config file (below).
* `ui/`: the regtest test surface (HTML/CSS/JS, no build step, no dependencies). The existing
  Angular wallet UI (`packages/wallet-fe`) is the production UI; moving it onto these commands is
  the next step and is not done in this commit.
* `capabilities/main.json`: grants nothing beyond the app's own commands.

## Configuration

`$TL_DESKTOP_CONFIG`, else `<app config dir>/config.json`
(`%APPDATA%\org.tradelayer.desktop\config.json` on Windows):

```json
{ "network": "BTCREGTEST",
  "node_url": "http://127.0.0.1:18443",
  "rpc_cookie_file": "C:/path/to/regtest/.cookie" }
```

`rpc_user` + `rpc_password` may replace `rpc_cookie_file`. `data_dir` (default: app data dir)
holds one vault directory per network id. `http` is accepted only for loopback node URLs
(`tl-rpc-client` policy); remote nodes need `https`.

## Commands and results (2026-11-02, Windows 11, MSVC 14.44, Rust 1.90.0)

```bat
call "...\VC\Auxiliary\Build\vcvars64.bat"
cd rust\tl-desktop
cargo test --locked                                  :: 7 passed
cargo clippy --locked --all-targets -- -D warnings   :: clean
cargo fmt --all -- --check                           :: clean
cargo build --locked
node scripts\e2e-regtest.mjs <target>\debug\tl-desktop.exe <out dir>   :: E2E_OK
```

`scripts/e2e-regtest.mjs` starts a throwaway Bitcoin Core 31.1 `-regtest` node (own temporary
datadir, cookie auth, `-listen=0`), launches the app with WebView2 remote debugging, and drives the
UI through the DevTools protocol. It runs these checks:

1. A fresh data dir opens on setup, with the chain shown as regtest. Create shows 12 words and
   clears them after the backup step.
2. The receive address is accepted by the node's `validateaddress`.
3. After the node wallet sends 1.5 and one block is mined, the balance shows 1.50000000.
4. Preparing a send of 0.4 at 3 sat/vB gives a preview where amount + fee + change = input.
5. On confirm:
   * the txid is in the node's mempool;
   * the transaction pays 0.4 to the destination and spends the funding outpoint;
   * the node's fee equals the previewed fee (459 sat, 141 vB);
   * after a block, the balance equals the change.
6. Through the IPC the page uses:
   * unknown or garbage plan ids are refused;
   * `plugin:event|emit` is refused as not allowed;
   * an inline script inserted by the page does not run, and `fetch` to an external origin fails.
7. Lock refuses `receive_address`, a wrong password is refused, the right password restores the
   same address, and a restarted app opens locked.

## Dependencies

`tauri`/`tauri-build` 2 (the shell), `serde`/`serde_json` (IPC values and the config file),
`getrandom` 0.3 (OS randomness for mnemonics, plan ids, KDF salts and nonces), `tl-desktop-core`
(path), and `tl-wallet-core` (TL-Extension) and `tl-rpc-client` (tl-rpc), both pinned to pushed
git revisions in `Cargo.toml`. The lockfile holds about 400 packages, almost all from Tauri.

## Gaps

* The Angular UI is not wired yet (see Layout).
* No installer, code signing or updater (`bundle.active` is false).
* Only built and run on Windows. The CI workflow `.github/workflows/rust-tl-desktop.yml` targets
  `windows-2022` and has not run (it triggers on pull requests).
* Linux and macOS builds have not been attempted.
* There is no TradeLayer token, trading or channel support yet. The core scans one receive and
  one change address; there is no gap-limit scan.
* No Litecoin node run: the e2e uses Bitcoin Core regtest. `LTCREGTEST` is configured but has not
  been exercised.
