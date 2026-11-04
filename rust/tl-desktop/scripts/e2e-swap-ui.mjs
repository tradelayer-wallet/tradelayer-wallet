// Two traders, two tl-desktop instances running the original Angular UI, each on its own
// Bitcoin Core regtest node (peered) behind the TradeLayer RPC test double, one legacy
// tl-orderbook-server. Seller and buyer place matching spot orders through the UI; the orderbook
// opens a channel; both swappers run their steps over the Rust relay and sign with their node
// wallets through the guarded sign routes. Windows: WebView2 + Bitcoin Core 31.1.
// Usage: node e2e-swap-ui.mjs <tl-desktop.exe> <orderbook url> <out dir>
// tl-rpc-double.mjs is a TEST DOUBLE: its TradeLayer payloads are not valid TradeLayer transactions,
// so this run verifies the wallet machinery (orders, relay, swap steps, node-wallet signing,
// broadcast), not TradeLayer consensus.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [exe, obUrl, outDir] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(process.env.LOCALAPPDATA, "Programs/BitcoinCore/bitcoin-31.1/bin");
const USER = "e2euser", PASS = "e2e-synthetic-rpc-password";
const MARKET = "TL/USDT";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); if (!ok) failures++; };
const killTree = (p) => { try { execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch (_) {} };
mkdirSync(outDir, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "tl-desktop-swap-e2e-"));
const procs = [];

const traders = [
  { name: "seller", rpc: 18981, p2p: 18991, dbl: 18983, cdp: 9351 },
  { name: "buyer", rpc: 18982, p2p: 18992, dbl: 18984, cdp: 9352 },
];
for (const t of traders) {
  t.dir = join(root, t.name);
  mkdirSync(join(t.dir, "node"), { recursive: true });
  mkdirSync(join(t.dir, "litecoin"), { recursive: true });
  t.cli = (...a) => execFileSync(join(BIN, "bitcoin-cli.exe"),
    [`-datadir=${join(t.dir, "node")}`, "-regtest", `-rpcport=${t.rpc}`, `-rpcuser=${USER}`, `-rpcpassword=${PASS}`, ...a],
    { encoding: "utf8" }).trim();
}

async function startNodes() {
  for (const t of traders) {
    const other = traders.find((o) => o !== t);
    const p = spawn(join(BIN, "bitcoind.exe"), [
      `-datadir=${join(t.dir, "node")}`, "-regtest", `-rpcport=${t.rpc}`, `-port=${t.p2p}`, "-bind=127.0.0.1",
      `-rpcuser=${USER}`, `-rpcpassword=${PASS}`, "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1",
      `-addnode=127.0.0.1:${other.p2p}`, "-fallbackfee=0.0002", "-txindex=1",
    ], { stdio: "ignore" });
    procs.push({ kind: "node", t, p });
  }
  for (const t of traders) {
    for (let i = 0; ; i++) { try { t.cli("getblockchaininfo"); break; } catch (e) { if (i > 80) throw e; await sleep(250); } }
  }
  // Token balances the double reports for every address: TL/USDT market properties 1 and 5.
  const statePath = join(root, "double-state.json");
  writeFileSync(statePath, JSON.stringify({ balances: { "*": [{ propertyId: 1, available: 10 }, { propertyId: 5, available: 10 }] } }));
  for (const t of traders) {
    const d = spawn(process.execPath, [join(here, "tl-rpc-double.mjs"), String(t.dbl), `http://127.0.0.1:${t.rpc}`, USER, PASS, statePath], { stdio: ["ignore", "pipe", "pipe"] });
    t.tlCalls = [];
    d.stdout.on("data", (b) => { for (const l of b.toString().split("\n")) if (l.trim()) t.tlCalls.push(l.trim()); });
    procs.push({ kind: "double", t, p: d });
    writeFileSync(join(t.dir, "litecoin", "litecoin.conf"), `rpcuser=${USER}\nrpcpassword=${PASS}\nrpcport=${t.dbl}\n`);
  }
  await sleep(800);
}

const BURN = () => {
  const info = JSON.parse(traders[0].cli("getdescriptorinfo", "raw(51)"));
  return info.descriptor;
};
const mineTo = (addr, n = 1) => traders[0].cli("generatetoaddress", String(n), addr);
const mineBurn = (n = 1) => traders[0].cli("generatetodescriptor", String(n), BURN());

async function launch(t) {
  const cfg = join(t.dir, "desktop-config.json");
  writeFileSync(cfg, JSON.stringify({
    network: "BTCREGTEST", node_url: `http://127.0.0.1:${t.rpc}`, rpc_user: USER, rpc_password: PASS,
    data_dir: join(t.dir, "desktop-data"), node_data_dir: join(t.dir, "litecoin"), orderbook_urls: [obUrl],
  }));
  const p = spawn(exe, [], { env: { ...process.env, TL_DESKTOP_CONFIG: cfg, WEBVIEW2_USER_DATA_FOLDER: join(t.dir, "webview"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${t.cdp}` }, stdio: "ignore" });
  procs.push({ kind: "app", t, p });
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${t.cdp}/json`)).json()).find((x) => x.type === "page"); } catch (_) {}
    if (!page) await sleep(250);
  }
  if (!page) throw new Error(`${t.name}: no webview page`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  t.errors = []; t.toasts = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === "Runtime.exceptionThrown") t.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  t.ws = ws;
  t.ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  t.shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(outDir, `${t.name}-${name}`), Buffer.from(s.result.data, "base64")); };
  t.waitFor = async (expr, ms = 20000) => { for (let x = 0; x < ms; x += 250) { try { if (await t.ev(expr)) return true; } catch (_) {} await sleep(250); } return false; };
  t.click = (txt, sel = "button, a, span, div, li") => t.ev(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.innerText && e.innerText.trim() === ${JSON.stringify(txt)}); const e = els[els.length - 1]; if (!e) return false; e.click(); return true; })()`);
  // Collect every toast the UI shows (Angular toastr), so swap steps and errors are visible.
  t.installToasts = () => t.ev(`(() => { if (window.__toasts) return true; window.__toasts = []; new MutationObserver(() => { for (const e of document.querySelectorAll(".ngx-toastr")) { const s = e.innerText.replace(/\\s+/g, " ").trim(); if (!e.__seen) { e.__seen = 1; window.__toasts.push(s); } } }).observe(document.body, { childList: true, subtree: true }); return true; })()`);
  t.readToasts = async () => (await t.ev(`window.__toasts || []`)) || [];
}

async function setup(t) {
  check(`${t.name}: Select Network`, await t.waitFor(`document.body.innerText.includes("Select Network")`));
  await t.installToasts();
  await t.click("Select Network", "button");
  await t.waitFor(`[...document.querySelectorAll("button")].some(b => /start node/i.test(b.innerText))`, 10000);
  await t.ev(`[...document.querySelectorAll("button")].find(b => /start node/i.test(b.innerText)).click()`);
  check(`${t.name}: node synced`, await t.waitFor(`document.body.innerText.includes("SYNCED")`, 30000));
  check(`${t.name}: Servers tab`, await t.click("Servers"));
  await t.waitFor(`document.body.innerText.includes("Orderbook Servers")`, 5000);
  await t.ev(`(() => { const i = [...document.querySelectorAll("input.input_url")][0]; i.closest(".server").click(); return true; })()`);
  await sleep(300);
  await t.ev(`(() => { const i = [...document.querySelectorAll("input.input_url")][0]; i.value = ${JSON.stringify(obUrl)}; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await t.ev(`[...document.querySelectorAll("button")].filter(b => b.innerText.trim() === "Connect")[0].click()`);
  check(`${t.name}: orderbook connected`, await t.waitFor(`[...document.querySelectorAll("button")].some(b => b.innerText.trim() === "disconnect")`, 15000));
  check(`${t.name}: open Spot Trading`, await t.click("Spot Trading"));
  await t.waitFor(`document.body.innerText.includes("TL/USDT")`, 15000);
  // TL/USDT (properties 1 and 5): wallet-fe's handleBuySell drops orders whose property id is 0
  // (`!propIdDesired`), and this orderbook lists LTC as property 0.
  check(`${t.name}: select TL/USDT market`, await t.click(MARKET));
  await sleep(800);
  const created = await t.click("Create Spot Address", "button");
  check(`${t.name}: Create Spot Address clicked`, created);
  check(`${t.name}: spot address shown`, await t.waitFor(`!document.body.innerText.includes("Create Spot Address")`, 20000), (await t.readToasts()).join(" | "));
  // Full address of the node-wallet key the card now uses, read from the node wallet itself.
  const addrs = await t.ev(`fetch("http://tlapi.localhost/api/rpc-call", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({method: "getaddressesbylabel", params: ["tl-wallet"]})}).then(r => r.json()).then(j => Object.keys(j.data || {}))`);
  t.address = addrs[addrs.length - 1];
  console.log(`${t.name} address:`, t.address, `(${addrs.length} in node wallet)`);
  check(`${t.name}: node-wallet address exists`, typeof t.address === "string" && t.address.startsWith("bcrt1"), JSON.stringify(addrs));
}

async function placeOrder(t, side, price, amount) {
  await t.ev(`(() => {
    for (const i of document.querySelectorAll("input[formcontrolname=price], input[formcontrolname=amount]")) {
      i.value = i.getAttribute("formcontrolname") === "price" ? ${JSON.stringify(String(price))} : ${JSON.stringify(String(amount))};
      i.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  })()`);
  await sleep(500);
  const r = await t.ev(`(() => { const b = [...document.querySelectorAll("button")].find(b => b.innerText.trim() === ${JSON.stringify(side)}); if (!b) return "no button"; if (b.disabled) return "disabled"; b.click(); return "clicked"; })()`);
  return r;
}

let miner = null;
try {
  await startNodes();
  mineBurn(1);
  for (const t of traders) await launch(t);
  for (const t of traders) await setup(t);

  // Fund both node-wallet spot addresses with mature coinbase outputs.
  for (const t of traders) mineTo(t.address, 1);
  mineBurn(101);
  for (const t of traders) {
    await t.ev(`document.querySelectorAll("button")`);
    const bal = Number(t.cli("-rpcwallet=tl-wallet", "getbalance"));
    check(`${t.name}: node wallet funded`, bal > 0, String(bal));
  }
  await sleep(4000);
  for (const t of traders) await t.shot("01-ready.png");

  // Keep blocks coming while the swap runs (commit transactions may wait for confirmations).
  miner = setInterval(() => { try { mineBurn(1); } catch (_) {} }, 3000);

  const sell = await placeOrder(traders[0], "Sell", 0.5, 1);
  check("seller: Sell clicked", sell === "clicked", `${sell}; toasts ${(await traders[0].readToasts()).join(" | ")}`);
  await sleep(1500);
  const buy = await placeOrder(traders[1], "Buy", 0.5, 1);
  check("buyer: Buy clicked", buy === "clicked", `${buy}; toasts ${(await traders[1].readToasts()).join(" | ")}`);

  // Wait for the swap to finish or fail on both sides.
  const done = async (t) => t.waitFor(`(window.__toasts || []).some(s => /Trade Error|terminat|completed|success/i.test(s))`, 120000);
  const [sDone, bDone] = await Promise.all([done(traders[0]), done(traders[1])]);
  for (const t of traders) {
    const toasts = await t.readToasts();
    console.log(`${t.name} toasts:`, JSON.stringify(toasts));
    console.log(`${t.name} tl_ calls:`, t.tlCalls.map((l) => { try { return JSON.parse(l).method; } catch (_) { return l; } }).join(","));
    await t.shot("02-after-swap.png");
    check(`${t.name}: swap finished without Trade Error`, (t === traders[0] ? sDone : bDone) && !toasts.some((s) => /Trade Error/i.test(s)), toasts.slice(-4).join(" | "));
  }
  // Transactions the swap broadcast: anything on chain or in the mempool carrying the double's tag.
  const tagged = [];
  const node = traders[0];
  const best = Number(node.cli("getblockcount"));
  for (let h = Math.max(0, best - 60); h <= best; h++) {
    const blk = JSON.parse(node.cli("getblock", node.cli("getblockhash", String(h)), "2"));
    for (const tx of blk.tx) for (const o of tx.vout) if (o.scriptPubKey?.type === "nulldata" && /6a.*746c/.test(o.scriptPubKey.hex)) tagged.push({ h, txid: tx.txid });
  }
  console.log("payload-tagged txs on chain:", JSON.stringify(tagged));
  check("swap transactions with TradeLayer payloads were mined", tagged.length >= 2, String(tagged.length));
  for (const t of traders) check(`${t.name}: no uncaught page exceptions`, t.errors.length === 0, t.errors.slice(0, 2).join(" | ").slice(0, 600));
} catch (e) {
  check("run completed without exception", false, e.stack || String(e));
} finally {
  if (miner) clearInterval(miner);
  for (const t of traders) { try { t.ws?.close(); } catch (_) {} }
  for (const x of procs.filter((x) => x.kind !== "node")) killTree(x.p);
  for (const t of traders) { try { t.cli("stop"); } catch (_) {} }
  await sleep(3000);
  try { rmSync(root, { recursive: true, force: true }); } catch (_) {}
  console.log(failures === 0 ? "E2E_SWAP_OK" : `E2E_SWAP_FAIL ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
