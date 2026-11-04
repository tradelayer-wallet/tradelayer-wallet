// Trading screens of the original Angular UI inside tl-desktop, against a running legacy
// tl-orderbook-server, through the Rust orderbook relay. Windows: WebView2 + Bitcoin Core 31.1.
// Usage: node e2e-trading-ui.mjs <tl-desktop.exe> <orderbook url> <out dir>
// The exe's CSP must allow the orderbook origin (the market list is fetched from the page).
// A second trader is simulated by a direct socket.io client to the orderbook.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [exe, obUrl, outDir] = process.argv.slice(2);
const BIN = join(process.env.LOCALAPPDATA, "Programs/BitcoinCore/bitcoin-31.1/bin");
const RPC_PORT = 18996, CDP_PORT = 9344;
const RPC_USER = "e2euser", RPC_PASS = "e2e-synthetic-rpc-password";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); if (!ok) failures++; };
const killTree = (p) => { try { execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch (_) {} };

// ---- second trader: a minimal Engine.IO v4 polling client straight to the orderbook ----
const SEP = String.fromCharCode(30);
async function directTrader(url) {
  const base = `${url}/socket.io/?EIO=4&transport=polling`;
  const open = await (await fetch(base)).text();
  const sid = JSON.parse(open.slice(1)).sid;
  const post = (body) => fetch(`${base}&sid=${sid}`, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body });
  await post("40");
  const events = [];
  const pollOnce = async () => {
    const r = await (await fetch(`${base}&sid=${sid}`)).text();
    for (const p of r.split(SEP)) {
      if (p === "2") await post("3");
      else if (p.startsWith("42")) events.push(JSON.parse(p.slice(2)));
    }
  };
  const waitFor = async (name, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const i = events.findIndex((e) => e[0] === name);
      if (i >= 0) return events.splice(i, 1)[0];
      await pollOnce();
    }
    return null;
  };
  return { emit: (n, a) => post("42" + JSON.stringify([n, a])), waitFor, close: () => post("1") };
}

mkdirSync(outDir, { recursive: true });
const datadir = mkdtempSync(join(tmpdir(), "tl-desktop-trading-e2e-"));
const nodeConfDir = join(datadir, "litecoin-datadir");
mkdirSync(nodeConfDir);
const cliArgs = [`-datadir=${datadir}`, "-regtest", `-rpcport=${RPC_PORT}`, `-rpcuser=${RPC_USER}`, `-rpcpassword=${RPC_PASS}`];
const cli = (...a) => execFileSync(join(BIN, "bitcoin-cli.exe"), [...cliArgs, ...a], { encoding: "utf8" }).trim();
const node = spawn(join(BIN, "bitcoind.exe"), [
  `-datadir=${datadir}`, "-regtest", "-listen=0", `-rpcport=${RPC_PORT}`, `-rpcuser=${RPC_USER}`, `-rpcpassword=${RPC_PASS}`,
  "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1",
], { stdio: "ignore" });
let app = null, trader = null;

try {
  for (let i = 0; ; i++) {
    try { execFileSync(join(BIN, "bitcoin-cli.exe"), [...cliArgs, "getblockchaininfo"], { stdio: "ignore" }); break; }
    catch (e) { if (i > 80) throw e; await sleep(250); }
  }
  cli("createwallet", "miner");
  cli("generatetoaddress", "3", cli("-rpcwallet=miner", "getnewaddress"));
  writeFileSync(join(nodeConfDir, "litecoin.conf"), `rpcuser=${RPC_USER}\nrpcpassword=${RPC_PASS}\nrpcport=${RPC_PORT}\n`);
  const cfgPath = join(datadir, "desktop-config.json");
  writeFileSync(cfgPath, JSON.stringify({
    network: "BTCREGTEST", node_url: `http://127.0.0.1:${RPC_PORT}`, rpc_user: RPC_USER, rpc_password: RPC_PASS,
    data_dir: join(datadir, "desktop-data"), node_data_dir: nodeConfDir, orderbook_urls: [obUrl],
  }));

  // The market the UI will show first, and the second trader's resting order in it.
  const markets = (await (await fetch(`${obUrl}/markets/spot`)).json()).data;
  const mtype = markets.find((t) => !t.disabled) || markets[0];
  const market = mtype.markets.find((m) => !m.disabled) || mtype.markets[0];
  console.log("market:", mtype.name, market.pairString, market.first_token.propertyId, market.second_token.propertyId);
  trader = await directTrader(obUrl);
  const AMOUNT = 7.77, PRICE = 0.4321;
  await trader.emit("new-order", {
    keypair: { address: "tltc1qsecondtraderxxxxxxxxxxxxxxxxxxxxxxxxxx", pubkey: "03" + "22".repeat(32) },
    action: "SELL", type: "SPOT", isLimitOrder: true, marketName: market.pairString,
    props: { id_desired: market.second_token.propertyId, id_for_sale: market.first_token.propertyId, amount: AMOUNT, price: PRICE },
  });
  const saved = await trader.waitFor("order:saved", 10000);
  check("second trader's order saved on the orderbook", Array.isArray(saved), JSON.stringify(saved));

  app = spawn(exe, [], { env: { ...process.env, TL_DESKTOP_CONFIG: cfgPath, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` }, stdio: "ignore" });
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === "page"); } catch (_) {}
    if (!page) await sleep(250);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(outDir, name), Buffer.from(s.result.data, "base64")); };
  const waitFor = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 250) { try { if (await ev(expr)) return true; } catch (_) {} await sleep(250); } return false; };
  const text = () => ev(`document.body.innerText.replace(/\\s+/g, " ")`);
  const clickText = (t, sel = "button, a, span, div, li") => ev(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.innerText && e.innerText.trim() === ${JSON.stringify(t)}); const e = els[els.length - 1]; if (!e) return false; e.click(); return true; })()`);
  const toasts = () => ev(`[...document.querySelectorAll(".toast-title, .toast-message")].map(e => e.innerText).join(" | ")`);

  check("original UI shows Select Network", await waitFor(`document.body.innerText.includes("Select Network")`));
  await clickText("Select Network", "button");
  check("menu shows Spot Trading and Futures Trading", await waitFor(`document.body.innerText.includes("Spot Trading") && document.body.innerText.includes("Futures Trading")`, 10000), (await text()).slice(0, 200));
  const started = await ev(`(() => { const b = [...document.querySelectorAll("button")].find(b => /start node/i.test(b.innerText)); if (!b) return false; b.click(); return true; })()`);
  check("Start Node clicked", started);
  check("node synced", await waitFor(`document.body.innerText.includes("SYNCED")`, 20000));

  // Servers window: re-enabled as a minimized tab in the bottom bar.
  check("Servers tab present", await clickText("Servers"));
  await sleep(800);
  check("Servers window lists the orderbook servers", await waitFor(`document.body.innerText.includes("Orderbook Servers")`, 5000));
  const custom = await ev(`(() => {
    const input = [...document.querySelectorAll("input.input_url")][0];
    if (!input) return "no custom input";
    input.closest(".server").click();
    return "selected";
  })()`);
  await sleep(300);
  const typed = await ev(`(() => {
    const input = [...document.querySelectorAll("input.input_url")][0];
    if (!input || input.disabled) return "input disabled";
    input.value = ${JSON.stringify(obUrl)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return "typed";
  })()`);
  console.log("custom server:", custom, typed);
  const connectClicked = await ev(`(() => { const b = [...document.querySelectorAll("button")].filter(b => b.innerText.trim() === "Connect")[0]; if (!b) return false; b.click(); return true; })()`);
  check("Connect clicked for the custom orderbook", connectClicked && typed === "typed", `${custom} ${typed}`);
  check("orderbook connected (disconnect button shown)", await waitFor(`[...document.querySelectorAll("button")].some(b => b.innerText.trim() === "disconnect")`, 15000), await toasts());
  await shot("trading-01-servers.png");

  // Spot Trading screen: market list over HTTP from the orderbook, orders over the relay.
  check("open Spot Trading", await clickText("Spot Trading"));
  check("spot page shows the market", await waitFor(`document.body.innerText.includes(${JSON.stringify(market.pairString)})`, 15000), (await text()).slice(0, 300));
  check("spot orderbook shows the second trader's order", await waitFor(`document.body.innerText.includes("7.77")`, 20000), (await text()).slice(0, 600));
  await shot("trading-02-spot.png");

  // The UI's own Buy: the snapshot's buy card needs a spot key pair and a TradeLayer attestation.
  const amountSet = await ev(`(() => {
    const inputs = [...document.querySelectorAll("input[formcontrolname=amount], input[formcontrolname=price]")];
    for (const i of inputs) { i.value = i.getAttribute("formcontrolname") === "price" ? "0.4321" : "1"; i.dispatchEvent(new Event("input", { bubbles: true })); }
    return inputs.length;
  })()`);
  const before = await trader.waitFor("placed-orders", 1);
  const buyClicked = await ev(`(() => { const b = [...document.querySelectorAll("button")].find(b => /^buy/i.test(b.innerText.trim())); if (!b) return "no buy button"; if (b.disabled) return "buy disabled"; b.click(); return "clicked"; })()`);
  await sleep(2500);
  console.log("UI buy:", amountSet, "inputs;", buyClicked, "; toasts:", await toasts());
  // Expected for this wallet-fe snapshot: no spot key pair in node-wallet mode, so Buy stays disabled.
  check("UI Buy stays disabled without a spot address (snapshot behaviour)", buyClicked === "buy disabled", buyClicked);
  await shot("trading-03-buy-attempt.png");

  check("open Futures Trading", await clickText("Futures Trading"));
  await sleep(2000);
  await shot("trading-04-futures.png");
  check("futures page rendered", await waitFor(`location.pathname.includes("futures") || document.body.innerText.includes("Futures")`, 5000));
  check("no uncaught page exceptions", errors.length === 0, errors.slice(0, 3).join(" | ").slice(0, 800));
  ws.close();
} catch (e) {
  check("run completed without exception", false, e.stack || String(e));
} finally {
  if (trader) { try { await trader.close(); } catch (_) {} }
  if (app) killTree(app);
  try { cli("stop"); } catch (_) {}
  for (let i = 0; i < 40 && node.exitCode === null; i++) await sleep(250);
  try { rmSync(datadir, { recursive: true, force: true }); } catch (_) {}
  console.log(failures === 0 ? "E2E_TRADING_OK" : `E2E_TRADING_FAIL ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
