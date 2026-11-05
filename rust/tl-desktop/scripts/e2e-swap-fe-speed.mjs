// Two-party spot swap through the FE-speed wallet UI (the default tl-desktop build) on two peered
// Bitcoin Core regtest nodes with descriptor wallets, against a local tl-orderbook-server.
// Windows: WebView2 + Bitcoin Core 31.1.
//
// Usage: node e2e-swap-fe-speed.mjs <tl-desktop.exe> <orderbook origin, e.g. ws://127.0.0.1:3001> <out dir>
//
// What it proves, in order (each stage is a PASS/FAIL line; the first failure prints where the run
// stopped):
//   1. two app instances (own WebView2 profile, own desktop config) start, each with its own regtest
//      node (descriptor wallet `tl-wallet` created by the UI, nodes peered) and its own
//      tl-listener-double (tl_listener_url); orderbook_urls names the local orderbook;
//   2. both UIs: Select Network, Start Node, Servers window connects the orderbook, Portfolio creates
//      the spot address (getnewaddress in the node wallet), Spot Trading opens the market TLt/USDTt
//      (properties 1 and 5, both non-zero);
//   3. the miner funds both addresses (coinbase to the address, 101 maturing blocks to a raw(51)
//      burn script) and runs for the whole swap;
//   4. the seller places a SELL and the buyer the matching BUY from the UI; the orderbook matches
//      them and opens the channel;
//   5. the swappers run: both commit transactions (payload `tl4...`, paying the sorted 2-of-2
//      channel multisig) are broadcast and mined, the trade transaction (payload `tlk...`) spends the
//      channel commit output, was signed by both node wallets through `tln1:` handles on the
//      descriptor wallets (PSBT), and is mined; the UIs toast the completion and show no "Trade Error".
//
// The exe's CSP must allow the orderbook origin (the page fetches /markets/spot/LTCTEST from it):
//   node scripts/skin-csp.mjs "<csp of tauri.conf.json>" --dist <dist dir> --connect http://127.0.0.1:3001
//        --connect ws://127.0.0.1:3001      (prints the TAURI_CONFIG for `cargo build`)
// The orderbook server must accept the relay's login (branch `auth`), or be the scratch export that
// treats every client as `desktop` (OB_FORCE_DESKTOP=1, see README "FE-speed swap run").
//
// tl-listener-double.mjs is a TEST DOUBLE: it applies the `tl4`/`tlk` payloads with bookkeeping of its
// own, it is not TradeLayer consensus. This run verifies the wallet machinery: orders, orderbook,
// channel funding transactions, PSBT signing on descriptor wallets, broadcast and mining.
//
// Environment: SWAP_AMOUNT (default 1), SWAP_PRICE (default 0.5), BITCOIN_BIN, SWAP_KEEP=1 (leave the
// temp dir), SWAP_STOP_AFTER=<stage name> (stop cleanly after that stage), SWAP_TIMEOUT_S (default 150),
// SWAP_LATE_S (seconds to wait after completion for the swappers' 60 s timers, default 70).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [exe, obOrigin, outDir] = process.argv.slice(2);
if (!exe || !obOrigin || !outDir) {
  console.error("usage: node e2e-swap-fe-speed.mjs <tl-desktop.exe> <orderbook origin> <out dir>");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const BIN = process.env.BITCOIN_BIN || join(process.env.LOCALAPPDATA, "Programs/BitcoinCore/bitcoin-31.1/bin");
const USER = "swapuser";
const PASS = "swap-synthetic-rpc-password";
const PAIR = "TLt/USDTt"; // LTCTEST spot market of properties 1 (base) and 5 (quote)
const AMOUNT = Number(process.env.SWAP_AMOUNT || 1);
const PRICE = Number(process.env.SWAP_PRICE || 0.5);
const SWAP_TIMEOUT_MS = Number(process.env.SWAP_TIMEOUT_S || 150) * 1000;
const wsOrigin = obOrigin.replace(/\/+$/, "");
const wsUrl = `${wsOrigin}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let stage = "start";
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!ok) failures++;
  return ok;
};
class Stop extends Error {}
const must = (name, ok, detail = "") => {
  if (!check(name, ok, detail)) throw new Stop(name);
};
const killTree = (p) => {
  try {
    execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
  } catch (_) {}
};
mkdirSync(outDir, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "tl-desktop-swap-fe-"));
const procs = [];

const traders = [
  { name: "seller", rpc: 18981, p2p: 18991, lst: 18983, cdp: 9361 },
  { name: "buyer", rpc: 18982, p2p: 18992, lst: 18984, cdp: 9362 },
];
for (const t of traders) {
  t.dir = join(root, t.name);
  mkdirSync(join(t.dir, "node"), { recursive: true });
  mkdirSync(join(t.dir, "litecoin"), { recursive: true });
  t.cli = (...a) =>
    execFileSync(join(BIN, "bitcoin-cli.exe"), [`-datadir=${join(t.dir, "node")}`, "-regtest", `-rpcport=${t.rpc}`, `-rpcuser=${USER}`, `-rpcpassword=${PASS}`, ...a], { encoding: "utf8" }).trim();
  t.cliw = (...a) => t.cli("-rpcwallet=tl-wallet", ...a);
}
const seller = traders[0];
const buyer = traders[1];
const miner = traders[0];

async function startNodes() {
  for (const t of traders) {
    const other = traders.find((o) => o !== t);
    const p = spawn(
      join(BIN, "bitcoind.exe"),
      [
        `-datadir=${join(t.dir, "node")}`, "-regtest", `-rpcport=${t.rpc}`, `-port=${t.p2p}`, "-bind=127.0.0.1", `-rpcuser=${USER}`, `-rpcpassword=${PASS}`,
        "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1", `-addnode=127.0.0.1:${other.p2p}`, "-fallbackfee=0.0002", "-txindex=1",
      ],
      { stdio: "ignore" },
    );
    procs.push({ kind: "node", t, p });
  }
  for (const t of traders) {
    for (let i = 0; ; i++) {
      try {
        t.cli("getblockchaininfo");
        break;
      } catch (e) {
        if (i > 120) throw e;
        await sleep(250);
      }
    }
  }
  // No wallet is loaded here: blocks are mined to a raw(51) script or to a trader's address, and the
  // node wallet `tl-wallet` the UI creates is then the only wallet, so the service's default-path RPCs resolve.
}
const burn = () => JSON.parse(miner.cli("getdescriptorinfo", "raw(51)")).descriptor;
const mineBurn = (n = 1) => miner.cli("generatetodescriptor", String(n), burn());
const mineTo = (addr, n = 1) => miner.cli("generatetoaddress", String(n), addr);

function startListeners() {
  for (const t of traders) {
    const cfg = join(t.dir, "listener-config.json");
    // Both properties of the market are held in whatever address the UI creates.
    writeFileSync(cfg, JSON.stringify({
      balances: { "*": [{ propertyId: 1, available: 1000 }, { propertyId: 5, available: 1000 }] },
      properties: { 1: { name: "TL test", ticker: "TLt" }, 5: { name: "USDT test", ticker: "USDTt" } },
    }));
    const p = spawn(process.execPath, [join(here, "tl-listener-double.mjs"), String(t.lst), `http://127.0.0.1:${t.rpc}`, USER, PASS, cfg], { stdio: ["ignore", "pipe", "pipe"] });
    t.listenerCalls = [];
    p.stdout.on("data", (b) => { for (const l of b.toString().split("\n")) if (l.trim()) t.listenerCalls.push(l.trim()); });
    p.stderr.on("data", (b) => t.listenerCalls.push("stderr: " + b.toString().trim()));
    procs.push({ kind: "listener", t, p });
    writeFileSync(join(t.dir, "litecoin", "litecoin.conf"), `rpcuser=${USER}\nrpcpassword=${PASS}\nrpcport=${t.rpc}\n`);
  }
}

async function launch(t) {
  const cfg = join(t.dir, "desktop-config.json");
  writeFileSync(cfg, JSON.stringify({
    network: "BTCREGTEST", node_url: `http://127.0.0.1:${t.rpc}`, rpc_user: USER, rpc_password: PASS,
    data_dir: join(t.dir, "desktop-data"), node_data_dir: join(t.dir, "litecoin"), orderbook_urls: [wsOrigin],
    tl_listener_url: `http://127.0.0.1:${t.lst}`, tl_rpc_via_listener: true,
  }));
  const p = spawn(exe, [], {
    env: { ...process.env, TL_DESKTOP_CONFIG: cfg, WEBVIEW2_USER_DATA_FOLDER: join(t.dir, "webview"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${t.cdp}` },
    stdio: "ignore",
  });
  t.app = p;
  procs.push({ kind: "app", t, p });
  let page;
  for (let i = 0; i < 160 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${t.cdp}/json`)).json()).find((x) => x.type === "page"); } catch (_) {}
    if (!page) await sleep(250);
  }
  if (!page) throw new Error(`${t.name}: no webview page`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  t.errors = [];
  t.console = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === "Runtime.exceptionThrown") t.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      if (t.console.length < 4000) t.console.push(`${msg.params.type}: ${text.slice(0, /signRes|signed res/.test(text) ? 20000 : 400)}`);
    }
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  t.ws = ws;
  t.ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  t.shot = async (name) => {
    const s = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, `${t.name}-${name}`), Buffer.from(s.result.data, "base64"));
  };
  t.waitFor = async (expr, ms = 20000) => {
    for (let x = 0; x < ms; x += 250) { try { if (await t.ev(expr)) return true; } catch (_) {} await sleep(250); }
    return false;
  };
  t.click = (txt, sel = "button, a, span, div, li") =>
    t.ev(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.innerText && e.innerText.trim() === ${JSON.stringify(txt)}); const e = els[els.length - 1]; if (!e) return false; e.click(); return true; })()`);
  // click the element with this text as soon as it exists (menus render a moment after dialogs close)
  t.clickWait = (txt, sel = "button, a, span, div, li", ms = 20000) =>
    t.waitFor(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.innerText && e.innerText.trim() === ${JSON.stringify(txt)}); const e = els[els.length - 1]; if (!e) return false; e.click(); return true; })()`, ms);
  // Every toast the UI shows (ngx-toastr), so swap steps and errors stay visible after they fade.
  t.installToasts = () =>
    t.ev(`(() => { if (window.__toasts) return true; window.__toasts = []; new MutationObserver(() => { for (const e of document.querySelectorAll(".ngx-toastr, .toast-container .toast")) { const s = e.innerText.replace(/\\s+/g, " ").trim(); if (s && !e.__seen) { e.__seen = 1; window.__toasts.push(s); } } }).observe(document.body, { childList: true, subtree: true }); return true; })()`);
  t.toasts = async () => (await t.ev(`window.__toasts || []`)) || [];
  // The orderbook relay's answers reach the page as socket.io long-poll frames; keep the ones that
  // carry an error, so "Orderbook Error [object Object]" toasts can be explained.
  t.installObTap = () =>
    t.ev(`(() => { if (window.__obTap) return true; const tap = window.__obTap = []; const send = XMLHttpRequest.prototype.send; XMLHttpRequest.prototype.send = function (...a) { this.addEventListener("load", () => { try { const x = String(this.responseText || ""); if (/OB_SOCKET::(order:error|auth_ignored|error)/.test(x)) tap.push(x.slice(0, 600)); if (this.status >= 400 && String(this.responseURL).includes("tlapi.localhost")) tap.push(this.status + " " + this.responseURL + " " + x.slice(0, 600)); } catch (_) {} }); return send.apply(this, a); }; return true; })()`);
  t.obErrors = async () => (await t.ev(`window.__obTap || []`)) || [];
}

async function setup(t) {
  must(`${t.name}: Select Network shown`, await t.waitFor(`document.body.innerText.includes("Select Network")`, 40000));
  await t.installToasts();
  await t.installObTap();
  await t.click("Select Network", "button");
  must(`${t.name}: Start Node clicked`, await t.waitFor(`(() => { const b = [...document.querySelectorAll("button")].find(b => /start node/i.test(b.innerText) && !b.disabled); if (!b) return false; b.click(); return true; })()`, 15000));
  must(`${t.name}: menu shows Spot Trading`, await t.waitFor(`document.body.innerText.includes("Spot Trading")`, 40000));
  must(`${t.name}: node synced`, await t.waitFor(`document.body.innerText.includes("SYNCED")`, 40000));
  // Servers window: the custom entry takes the ws URL.
  await t.ev(`(() => { const i = [...document.querySelectorAll("input.input_url")][0]; if (i) i.closest(".server").click(); return true; })()`);
  await sleep(400);
  const typed = await t.ev(`(() => { const i = [...document.querySelectorAll("input.input_url")][0]; if (!i || i.disabled) return "input disabled"; i.value = ${JSON.stringify(wsUrl)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "typed"; })()`);
  const clicked = await t.ev(`(() => { const b = [...document.querySelectorAll("button")].filter(b => b.innerText.trim() === "Connect")[0]; if (!b) return false; b.click(); return true; })()`);
  must(`${t.name}: Connect clicked for the orderbook`, clicked && typed === "typed", String(typed));
  must(`${t.name}: orderbook connected`, await t.waitFor(`[...document.querySelectorAll("button")].some(b => b.innerText.trim() === "disconnect")`, 20000));
}

async function createAddress(t) {
  // Opening Portfolio makes the UI create the node wallet `tl-wallet` itself, then it offers to encrypt
  // it (a password dialog); Cancel keeps the wallet unencrypted.
  must(`${t.name}: Portfolio opened`, await t.clickWait("Portfolio"));
  let loaded = false;
  for (let i = 0; i < 80 && !loaded; i++) { try { loaded = JSON.parse(t.cli("listwallets")).includes("tl-wallet"); } catch (_) {} if (!loaded) await sleep(250); }
  must(`${t.name}: the UI created the node wallet tl-wallet`, loaded);
  if (await t.waitFor(`document.body.innerText.includes("Password Required")`, 8000)) {
    must(`${t.name}: wallet-encryption prompt cancelled`, await t.click("Cancel", "button"));
    await sleep(500);
  }
  // New Address: `getnewaddress tl-wallet` on the node wallet the UI created.
  must(`${t.name}: New Address button`, await t.waitFor(`[...document.querySelectorAll("button")].some(b => /new address/i.test(b.innerText) && !b.disabled)`, 20000));
  await t.ev(`[...document.querySelectorAll("button")].find(b => /new address/i.test(b.innerText)).click()`);
  let n = 0;
  for (let i = 0; i < 40 && !n; i++) { try { n = Object.keys(JSON.parse(t.cliw("getaddressesbylabel", "tl-wallet"))).length; } catch (_) {} if (!n) await sleep(250); }
  must(`${t.name}: node wallet holds an address`, n > 0);
  const addrs = Object.keys(JSON.parse(t.cliw("getaddressesbylabel", "tl-wallet")));
  t.address = addrs[0];
  const info = JSON.parse(t.cliw("getaddressinfo", t.address));
  console.log(`${t.name} address ${t.address} (descriptor wallet: ${JSON.parse(t.cliw("getwalletinfo")).descriptors}, ismine ${info.ismine})`);
  must(`${t.name}: address is a regtest bech32 key of a descriptor wallet`, t.address.startsWith("bcrt1") && JSON.parse(t.cliw("getwalletinfo")).descriptors === true);
}

async function openMarket(t) {
  must(`${t.name}: Spot Trading opened`, await t.clickWait("Spot Trading"));
  must(`${t.name}: market ${PAIR} listed`, await t.waitFor(`document.body.innerText.includes(${JSON.stringify(PAIR)})`, 25000));
  await t.click(PAIR);
  await sleep(1000);
  must(`${t.name}: buy/sell card shows the spot address`, await t.waitFor(`(() => { const c = document.querySelector("tl-spot-buy-sell-card"); return !!c && /Address:/.test(c.innerText); })()`, 20000));
}

async function placeOrder(t, side, price, amount) {
  await t.ev(`(() => {
    for (const i of document.querySelectorAll("tl-spot-buy-sell-card input[formcontrolname=price], tl-spot-buy-sell-card input[formcontrolname=amount]")) {
      i.value = i.getAttribute("formcontrolname") === "price" ? ${JSON.stringify(String(price))} : ${JSON.stringify(String(amount))};
      i.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  })()`);
  await sleep(600);
  return t.ev(`(() => { const b = [...document.querySelectorAll("tl-spot-buy-sell-card button")].find(b => b.innerText.trim() === ${JSON.stringify(side)}); if (!b) return "no button"; if (b.disabled) return "disabled: " + document.querySelector("tl-spot-buy-sell-card").innerText.replace(/\\s+/g, " ").slice(0, 300); b.click(); return "clicked"; })()`);
}

const afterStage = (name) => {
  stage = name;
  if (process.env.SWAP_STOP_AFTER === name) throw new Stop(`stopped after ${name} as requested`);
};

/** Payload-carrying transactions on the chain of `node`: [{txid, height, text}] */
function tlTransactions(node) {
  const best = Number(node.cli("getblockcount"));
  const out = [];
  for (let h = 1; h <= best; h++) {
    const blk = JSON.parse(node.cli("getblock", node.cli("getblockhash", String(h)), "3"));
    for (const tx of blk.tx) {
      for (const o of tx.vout) {
        if (o.scriptPubKey?.type !== "nulldata") continue;
        const hex = (o.scriptPubKey.asm || "").split(" ")[1] || "";
        const text = Buffer.from(hex, "hex").toString("latin1");
        if (text.startsWith("tl")) out.push({ txid: tx.txid, height: h, text, tx });
      }
    }
  }
  return out;
}

let minerTimer = null;
try {
  stage = "nodes";
  await startNodes();
  startListeners();
  check("both regtest nodes run Bitcoin Core 31.x", traders.every((t) => /Satoshi:3[01]\./.test(JSON.parse(t.cli("getnetworkinfo")).subversion)));
  mineBurn(1);
  afterStage("nodes");

  stage = "launch";
  for (const t of traders) await launch(t);
  afterStage("launch");

  stage = "setup";
  for (const t of traders) await setup(t);
  afterStage("setup");

  stage = "address";
  for (const t of traders) await createAddress(t);
  afterStage("address");

  stage = "fund";
  for (const t of traders) mineTo(t.address, 2);
  mineBurn(101);
  await sleep(1500);
  for (const t of traders) {
    const bal = Number(t.cliw("getbalance"));
    must(`${t.name}: node wallet funded (mature coinbase)`, bal >= 100, String(bal));
  }
  for (const t of traders) await openMarket(t);
  await sleep(5000);
  must("both cards show attestation and token balances", await Promise.all(traders.map((t) => t.waitFor(`(() => { const c = document.querySelector("tl-spot-buy-sell-card"); return !!c && /Attestation:\\s*YES/.test(c.innerText) && /1000/.test(c.innerText); })()`, 30000))).then((r) => r.every(Boolean)));
  for (const t of traders) await t.shot("01-ready.png");
  afterStage("fund");

  // Keep blocks coming while the swap runs (the commit and trade transactions confirm as they go).
  minerTimer = setInterval(() => { try { mineBurn(1); } catch (_) {} }, 3000);

  stage = "orders";
  const sell = await placeOrder(seller, "Sell", PRICE, AMOUNT);
  must("seller: Sell clicked", sell === "clicked", `${sell}; toasts ${(await seller.toasts()).join(" | ")}`);
  await sleep(1500);
  const buy = await placeOrder(buyer, "Buy", PRICE, AMOUNT);
  must("buyer: Buy clicked", buy === "clicked", `${buy}; toasts ${(await buyer.toasts()).join(" | ")}`);
  // the orderbook either opens the channel (a swap step toast) or refuses an order
  const started = (t) => t.waitFor(`(window.__toasts || []).some(s => /Trade Info|Trade Error|Orderbook Error/i.test(s))`, 25000);
  await Promise.all(traders.map(started));
  for (const t of traders) {
    const refused = (await t.toasts()).filter((x) => /Orderbook Error/i.test(x));
    must(`${t.name}: the orderbook accepted the order`, refused.length === 0, `${refused.join(" | ")} :: ${(await t.obErrors()).join(" | ")}`);
  }
  afterStage("orders");

  stage = "swap";
  const finished = (t) => t.waitFor(`(window.__toasts || []).some(s => /Trade Error|Trade Completed|Trade completed/i.test(s))`, SWAP_TIMEOUT_MS);
  const [sDone, bDone] = await Promise.all([finished(seller), finished(buyer)]);
  for (const t of traders) {
    const toasts = await t.toasts();
    console.log(`${t.name} toasts:`, JSON.stringify(toasts));
    await t.shot("02-after-swap.png");
  }
  must("seller: the swap finished", sDone);
  must("buyer: the swap finished", bDone);
  // the commit and trade transactions confirm in the next blocks: mine and look until all three are there
  let chainTl = [];
  for (let i = 0; i < 20; i++) {
    try { mineBurn(1); } catch (_) {}
    await sleep(700);
    chainTl = tlTransactions(miner);
    if (chainTl.filter((x) => x.text.startsWith("tl4")).length >= 2 && chainTl.some((x) => x.text.startsWith("tlk"))) break;
  }
  const commits = chainTl.filter((x) => x.text.startsWith("tl4"));
  const trades = chainTl.filter((x) => x.text.startsWith("tlk"));
  console.log("commit txs:", JSON.stringify(commits.map((c) => ({ txid: c.txid, height: c.height, payload: c.text }))));
  console.log("trade txs:", JSON.stringify(trades.map((c) => ({ txid: c.txid, height: c.height, payload: c.text }))));
  check("two commit transactions were mined", commits.length === 2, String(commits.length));
  const channelAddr = commits[0]?.tx.vout.map((o) => o.scriptPubKey?.address).find((a) => a && a.length > 42);
  check("both commit transactions pay the same 2-of-2 channel multisig (P2WSH)", !!channelAddr && commits.every((c) => c.tx.vout.some((o) => o.scriptPubKey?.address === channelAddr)), String(channelAddr));
  check("the commit senders are the two traders", new Set(commits.map((c) => c.tx.vin[0].prevout.scriptPubKey.address)).size === 2 && commits.every((c) => [seller.address, buyer.address].includes(c.tx.vin[0].prevout.scriptPubKey.address)));
  check("one trade transaction was mined", trades.length === 1, String(trades.length));
  const trade = trades[0];
  if (trade) {
    check("the trade transaction spends a channel commit output signed with two witness signatures", trade.tx.vin.some((i) => i.prevout?.scriptPubKey?.address === channelAddr && i.txinwitness?.length === 4), JSON.stringify(trade.tx.vin.map((i) => i.txinwitness?.length)));
    check("the trade transaction has confirmations", Number(miner.cli("getrawtransaction", trade.txid, "true") && JSON.parse(miner.cli("getrawtransaction", trade.txid, "true")).confirmations) >= 1);
  }
  for (const t of traders) {
    const toasts = await t.toasts();
    check(`${t.name}: completion toast`, toasts.some((s) => /Trade Completed|Trade completed/i.test(s)));
  }
  // Wait out the swapper's 60 s whole-trade timer (FE-speed never cleared it): a Trade Error or a
  // TERMINATE_TRADE after the trade is done is a failure.
  const lateS = Number(process.env.SWAP_LATE_S || 70);
  console.log(`waiting ${lateS} s for the swappers' 60 s timers`);
  await sleep(lateS * 1000);
  for (const t of traders) {
    const toasts = await t.toasts();
    check(`${t.name}: no "Trade Error" toast, now or after the 60 s timer`, !toasts.some((s) => /Trade Error/i.test(s)), toasts.filter((s) => /error/i.test(s)).join(" | "));
    check(`${t.name}: no TERMINATE_TRADE after the trade`, !toasts.some((s) => /TERMINATE_TRADE/.test(s)), toasts.filter((s) => /TERMINATE/.test(s)).join(" | "));
    await t.shot("03-late.png");
  }
  afterStage("swap");
  // FE-speed plays a sound on completion; WebView2 refuses audio before a user gesture, and the driver's
  // clicks are synthetic. That rejection is the one page exception tolerated.
  const realErrors = (t) => t.errors.filter((e) => !e.includes("play() failed because the user didn't interact"));
  for (const t of traders) check(`${t.name}: no uncaught page exceptions`, realErrors(t).length === 0, realErrors(t).slice(0, 2).join(" | ").slice(0, 600));
  stage = "done";
} catch (e) {
  if (!(e instanceof Stop)) check("run completed without exception", false, e.stack || String(e));
  else console.log(`STOP: ${e.message}`);
  console.log(`E2E_SWAP_STOPPED_AT ${stage}`);
} finally {
  if (minerTimer) clearInterval(minerTimer);
  for (const t of traders) {
    try { if (t.shot) await t.shot("99-final.png"); } catch (_) {}
    try {
      writeFileSync(join(outDir, `${t.name}-console.log`), (t.console || []).join("\n"));
      writeFileSync(join(outDir, `${t.name}-listener.log`), (t.listenerCalls || []).join("\n"));
      writeFileSync(join(outDir, `${t.name}-errors.log`), (t.obErrors ? await t.obErrors().catch(() => []) : []).join("\n"));
    } catch (_) {}
    try { t.ws?.close(); } catch (_) {}
  }
  for (const x of procs.filter((x) => x.kind !== "node")) killTree(x.p);
  for (const t of traders) { try { t.cli("stop"); } catch (_) {} }
  await sleep(3000);
  if (!process.env.SWAP_KEEP) { try { rmSync(root, { recursive: true, force: true }); } catch (_) {} }
  else console.log(`kept ${root}`);
  console.log(failures === 0 && stage === "done" ? "E2E_SWAP_FE_SPEED_OK" : `E2E_SWAP_FE_SPEED_FAIL ${failures} (stage ${stage})`);
  process.exit(failures === 0 && stage === "done" ? 0 : 1);
}
