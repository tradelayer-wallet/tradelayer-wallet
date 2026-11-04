# fe-speed-skin

A second overlay layer for the FE-speed UI build: live exchange charts from BitcornWisdom and a
chrome facelift. It is applied after `ui-overlay/fe-speed/` and does not touch that layer.

```bat
node scripts\build-ui.mjs --ref origin/FE-speed --name fe-speed --skin fe-speed-skin [work dir]
```

The build writes `dist-ui-fe-speed-skin/` (the base build in `dist-ui-fe-speed/` is left alone).
Without `--skin` the build is unchanged.

## Charts

FE-speed's two chart cards (spot and futures) loaded TradingView's `tv.js` from s3.tradingview.com
and fell back to Coinbase's brokerage REST. Both are replaced by one component, `tl-bitcorn-chart`
(`bitcorn-chart.component.ts`), which mounts BitcornWisdom's embed SDK and follows the selected
market. The SDK, `embed.html` and the modules they import are copied at build time from a pinned
BitcornWisdom commit into `<dist>/bitcorn/` (nothing is fetched from GitHub Pages or a CDN):

* `overlay.json` `bitcorn.commit` is the only commit the build accepts. The clone is found through
  `--bitcorn-dir`, `BITCORN_WISDOM_DIR`, or `bitcorn.defaultDirs`; a missing clone or another HEAD
  fails the build unless `--bitcorn-allow-other` is passed. Files are read from git objects, not the
  working tree.
* `<dist>/bitcorn/PROVENANCE.json` records the commit, each file's SHA-256 (before and after the
  patches) and the patches. `LICENSE` and `THIRD_PARTY_NOTICES.md` are copied along.
* Exact-count patches (a mismatch fails the build): LTC instruments added to BitcornWisdom's feed
  allowlist (`LTC-USD-SPOT`, `LTC-USDT-SPOT`, `LTC-USDT-PERP`; its set has BTC and ETH only), the
  `chrome` theme (canvas palette in `workspace.js`, bars and price pill in `embed.css`), the embed's
  own CSP narrowed to the nine exchange hosts, and the link to the unbundled full desk removed.

### Market to instrument (`bitcorn-instrument.ts`, tested by `scripts/test-bitcorn-instrument.mjs`)

Token names are canonicalised (`TLTC`, `sLTC`, `sLTCt` become LTC, `sBTC` BTC, `USDTt` USDT, `TLt` TL).

| TradeLayer market | Chart |
|---|---|
| spot or futures, LTC/BTC base against a USD-like quote (USDT, USDTt) | spot: `LTC-USD-SPOT` / `BTC-USD-SPOT` (Kraken, Coinbase failover) |
| futures contract LTC/USDT, BTC/USDT | `LTC-USDT-PERP` / `BTC-USDT-PERP` (Binance USD-M); if no source answers, the card switches to the asset's `*-USD-SPOT` and says so |
| TL (or another asset without an external price) against LTC or BTC | the quote asset's `*-USD-SPOT`, labelled "TL has no external market; showing the collateral asset LTC / USD" |
| TL against USDT, anything else | "No external market" state, no iframe |

### Content-Security-Policy

`tauri.conf.json` is not edited. `csp.json` lists the hosts the chart needs, with a reason each, and
one policy replacement: `frame-ancestors 'none'` becomes `'self'`, because the chart is a same-origin
iframe and the webview refuses to frame its own document otherwise (verified: with `'none'` the
console logs the violation and the chart never completes its handshake). `scripts/skin-csp.mjs`
merges `csp.json` into a base policy and prints a `TAURI_CONFIG` override for `cargo build`.

## Facelift (`styles-skin.scss`)

FE-speed's palette is kept (its `:root` variables are not redefined). The skin adds blue-steel
chrome gradients and sheen on the header, the active tab indicator, primary buttons, card borders and
the window/status bars, tighter radii, tabular figures, and green/red buy/sell buttons with a
metallic sheen. `scripts/check-skin-contrast.mjs` checks the text/background pairs against WCAG AA.

## Checking a build

`scripts/check-fe-speed-skin.mjs <exe> <out dir> <prefix> [--chart] [--mock-ob --ob ws://127.0.0.1:<port>]`
drives the app (regtest node, orderbook connect, every screen), saves screenshots, and with `--chart`
asserts that BitcornWisdom's `candle` event arrives for each mapped market within 60 s, that no CSP
violation or uncaught exception is logged, and that the iframe is gone after leaving the page.
