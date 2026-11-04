// Liveness soak of FE-speed's Angular UI (the fe-speed build) inside tl-desktop, against a real
// tl-orderbook-server. Windows: WebView2 + Bitcoin Core 31.1.
// Usage: node soak-fe-speed.mjs <tl-desktop.exe> <orderbook origin, e.g. ws://127.0.0.1:3001> <minutes>
//
// The exe is the fespeed test exe (frontendDist dist-ui-fe-speed) whose CSP allows the orderbook's
// http origin (the UI loads /markets/spot/<network> from it). The orderbook server runs from the
// scratch export that honours `x-tradelayer-client: desktop` on the upgrade (a direct "placer"
// client uses it to place orders; the relay itself is a web client and only reads). Optional env:
//   OB_STOP_CMD, OB_START_CMD  shell commands that stop and start the orderbook server; with both the
//                              run stops it once, keeps it down for 10 s and starts it again.
//   SOAK_MEM_SLOPE_MB_MIN      memory slope limit in MB/min after warm-up (default 1.0).
//   SOAK_OUT                   directory for screenshots (baseline, after each recovery).
//   SOAK_BASELINE_ONLY=1       the end-to-end check without the soak: connect, open Spot Trading, have
//                              the placer place orders, require the order book view to show them,
//                              take a screenshot; prints E2E_FE_SPEED_OK or SOAK_FAIL.
//   SOAK_PLAN                  replace the schedule, e.g. freeze:180,minimize:120,obrestart (unscaled).
//
// What it does: starts a throwaway bitcoind -regtest, launches the app with WebView2 remote
// debugging, drives Select Network / Start Node, connects the orderbook through the Servers
// window and opens Spot Trading on TLTC/USDTt. A placer client holds orders on that market. Then for
// <minutes>:
//   * mines a block every 20 s and requires the UI block counter to follow within 10 s;
//   * every 20 s the placer posts a new order (`many-orders`, which makes the server send
//     `update-orders-request`) and the order book in the UI must show its price within 10 s;
//   * minimizes/restores the window and freezes/resumes the page (Page.setWebLifecycleState),
//     and restarts the orderbook server once; after each disruption the main socket, the
//     orderbook link, the block counter AND the order book view (a fresh order placed at the
//     moment of resume) must be current again within 30 s;
//   * while minimized a 100 ms page timer must keep its rate (the WebView2 flags in tauri.conf.json);
//   * samples the working set of the app and its WebView2 processes every minute and fails on a
//     memory slope above the limit.
// Prints a timeline and SOAK_OK or SOAK_FAIL.
import { spawn, execFileSync, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [exe, obOrigin, minutesArg] = process.argv.slice(2);
const obUrl = obOrigin;
const wsUrl = `${(obOrigin || "").replace(/\/+$/, "")}/ws`;
const NET = "LTCTEST";
const MARKET = { key: "0-5", base: 0, quote: 5, pair: "TLTC/USDTt" };
const MINUTES = Number(minutesArg);
if (!exe || !obUrl || !(MINUTES > 0)) {
  console.error("usage: node soak-fe-speed.mjs <tl-desktop.exe> <orderbook origin> <minutes>");
  process.exit(2);
}
const BIN = join(process.env.LOCALAPPDATA, "Programs/BitcoinCore/bitcoin-31.1/bin");
const RPC_PORT = Number(process.env.RPC_PORT || 18997), CDP_PORT = Number(process.env.CDP_PORT || 9349);
const RPC_USER = "soakuser", RPC_PASS = "soak-synthetic-rpc-password";
const MEM_SLOPE_LIMIT = Number(process.env.SOAK_MEM_SLOPE_MB_MIN || "1.0");
const REQUIRED_FLAGS = ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"];
const SCALE = MINUTES / 45;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => { const s = Math.round((Date.now() - t0) / 1000); return `${String(Math.floor(s / 60)).padStart(3, "0")}:${String(s % 60).padStart(2, "0")}`; };
const timeline = [];
const log = (msg) => { const line = `[${stamp()}] ${msg}`; timeline.push(line); console.log(line); };
const failures = [];
const fail = (msg) => { failures.push(msg); log(`FAIL ${msg}`); };
const check = (name, ok, detail = "") => { log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); if (!ok) failures.push(name); return ok; };
const killTree = (pid) => { try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch (_) {} };
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { encoding: "utf8", maxBuffer: 32 << 20 }, (e, out, err) => (e ? rej(new Error(`${cmd}: ${err || e.message}`)) : res(out))));
const ps = (script) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

mkdirSync(join(tmpdir(), "tl-soak"), { recursive: true });
const datadir = mkdtempSync(join(tmpdir(), "tl-desktop-soak-"));
const nodeConfDir = join(datadir, "litecoin-datadir");
mkdirSync(nodeConfDir);
const cliArgs = [`-datadir=${datadir}`, "-regtest", `-rpcport=${RPC_PORT}`, `-rpcuser=${RPC_USER}`, `-rpcpassword=${RPC_PASS}`];
const cliSync = (...a) => execFileSync(join(BIN, "bitcoin-cli.exe"), [...cliArgs, ...a], { encoding: "utf8" }).trim();
const cli = (...a) => run(join(BIN, "bitcoin-cli.exe"), [...cliArgs, ...a]).then((s) => s.trim());
const node = spawn(join(BIN, "bitcoind.exe"), [
  `-datadir=${datadir}`, "-regtest", "-listen=0", `-rpcport=${RPC_PORT}`, `-rpcuser=${RPC_USER}`, `-rpcpassword=${RPC_PASS}`,
  "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1",
], { stdio: "ignore" });
let app = null, ws = null, minerStop = false, memStop = false;
const memSamples = [];
const recoveries = [];
const blockLags = [];
const bookLags = [];
const state = { blind: false, disrupting: false };

const OUT = process.env.SOAK_OUT ? resolve(process.env.SOAK_OUT) : null;
class Done extends Error {}

// ---- CDP ----
let msgId = 0;
const pending = new Map();
const pageErrors = [];
function cdp(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); m.error ? reject(new Error(`CDP ${method}: ${m.error.message}`)) : resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expr, timeoutMs = 15000) {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function screenshot(name) {
  if (!OUT) return;
  try {
    mkdirSync(OUT, { recursive: true });
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, name), Buffer.from(r.data, "base64"));
    log(`screenshot ${join(OUT, name)}`);
  } catch (e) { log(`screenshot ${name} failed: ${e.message}`); }
}
const waitFor = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 250) { try { if (await ev(expr)) return true; } catch (_) {} await sleep(250); } return false; };
const clickText = (t, sel = "button, a, span, div, li") => ev(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.innerText && e.innerText.trim() === ${JSON.stringify(t)}); const e = els[els.length - 1]; if (!e) return false; e.click(); return true; })()`);

const UI_STATE = `(() => {
  const card = document.querySelector("tl-spot-orderbook-card");
  const prices = card ? [...card.innerText.matchAll(/^(\\d+\\.\\d{4})\\t(\\d+\\.\\d{4})\\t(\\d+\\.\\d{4})$/gm)].map((m) => Number(m[1])) : null;
  const blk = document.body.innerText.match(/Block:\\s*(\\d+)/);
  return {
    main: !document.body.innerText.includes("No connection with local server"),
    ob: [...document.querySelectorAll("button")].some(b => b.innerText.trim() === "disconnect"),
    block: blk ? parseInt(blk[1], 10) : NaN,
    book: prices,
    vis: document.visibilityState,
  };
})()`;
const uiState = () => ev(UI_STATE, 8000);
const chainHeight = async () => Number(await cli("getblockcount"));

// ---- windows ----
const winScript = (action) => `
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);'
$p = Get-Process -Id ${app.pid}; $h = $p.MainWindowHandle
if ('${action}' -eq 'min') { [void][W.U]::ShowWindow($h, 6) } elseif ('${action}' -eq 'restore') { [void][W.U]::ShowWindow($h, 9) }
Start-Sleep -Milliseconds 400
Write-Output ([W.U]::IsIconic($h))`;
const isIconic = async (action = "query") => (await ps(winScript(action))).trim() === "True";
async function setWindow(minimized) {
  let how = "cdp";
  try {
    const { windowId } = await cdp("Browser.getWindowForTarget");
    await cdp("Browser.setWindowBounds", { windowId, bounds: { windowState: minimized ? "minimized" : "normal" } });
    await sleep(500);
  } catch (e) { how = `cdp-failed(${e.message.slice(0, 60)})`; }
  let iconic = await isIconic();
  if (iconic !== minimized) { how += "+win32"; iconic = await isIconic(minimized ? "min" : "restore"); }
  return { how, iconic };
}

// ---- processes ----
async function pidOnPort(port) {
  const out = await run("netstat", ["-ano", "-p", "TCP"]);
  for (const line of out.split(/\r?\n/)) {
    const c = line.trim().split(/\s+/);
    if (c.length >= 5 && c[3] === "LISTENING" && c[1].endsWith(`:${port}`)) return Number(c[4]);
  }
  return null;
}
// Independent of the UI: does the app hold an established connection to the orderbook port?
// (the Rust relay client keeps one WebSocket open to the orderbook).
async function relayAlive() {
  const port = new URL(wsUrl).port;
  const out = await run("netstat", ["-ano", "-p", "TCP"]);
  return out.split(/\r?\n/).some((l) => { const c = l.trim().split(/\s+/); return c.length >= 5 && c[3] === "ESTABLISHED" && c[2].endsWith(`:${port}`) && Number(c[4]) === app.pid; });
}
async function processTable() {
  const out = await ps("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime,CommandLine | ConvertTo-Json -Compress");
  const rows = JSON.parse(out);
  return Array.isArray(rows) ? rows : [rows];
}
function subtree(rows, rootPid) {
  const kids = new Map();
  for (const r of rows) { (kids.get(r.ParentProcessId) || kids.set(r.ParentProcessId, []).get(r.ParentProcessId)).push(r); }
  const out = []; const stack = [rootPid];
  const root = rows.find((r) => r.ProcessId === rootPid); if (root) out.push(root);
  while (stack.length) for (const k of kids.get(stack.pop()) || []) { out.push(k); stack.push(k.ProcessId); }
  return out;
}
// CPU seconds per process of the app tree, to tell a busy page from an idle one after a thaw.
async function cpuSnapshot() {
  const rows = subtree(await processTable(), app.pid);
  return new Map(rows.map((r) => [r.ProcessId, { name: r.Name, cpu: (Number(r.KernelModeTime) + Number(r.UserModeTime)) / 1e7 }]));
}
function cpuDelta(a, b) {
  return [...b].map(([pid, v]) => ({ pid, name: v.name, d: v.cpu - (a.get(pid)?.cpu ?? v.cpu) })).sort((x, y) => y.d - x.d).slice(0, 3)
    .map((x) => `${x.name}#${x.pid} +${x.d.toFixed(1)}s`).join(", ");
}
const systemLoad = () => ps("(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average").then((o) => o.trim()).catch(() => "?");
async function sampleMemory() {
  const rows = subtree(await processTable(), app.pid);
  const appMb = rows.filter((r) => r.ProcessId === app.pid).reduce((a, r) => a + r.WorkingSetSize, 0) / 1048576;
  const wvMb = rows.filter((r) => r.ProcessId !== app.pid).reduce((a, r) => a + r.WorkingSetSize, 0) / 1048576;
  const s = { min: (Date.now() - t0) / 60000, appMb, wvMb, totalMb: appMb + wvMb, procs: rows.length, steady: !state.disrupting };
  memSamples.push(s);
  log(`memory: app ${appMb.toFixed(1)} MB + webview2 ${wvMb.toFixed(1)} MB (${rows.length} processes) = ${s.totalMb.toFixed(1)} MB${s.steady ? "" : " (during a disruption; not in the slope)"}`);
}

// ---- page probes ----
const PROBE_INSTALL = `(() => {
  if (window.__soak) return "already";
  const p = window.__soak = { ticks: 0, last: Date.now(), maxGap: 0, since: Date.now(), ob: [] };
  setInterval(() => { const n = Date.now(); p.maxGap = Math.max(p.maxGap, n - p.last); p.last = n; p.ticks++; }, 100);
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener("load", () => { try { const t = String(this.responseText || ""); const m = t.match(/OB_SOCKET::[a-z_]+/g); if (m) for (const x of m) p.ob.push([Date.now(), x]); } catch (_) {} });
    return send.apply(this, a);
  };
  return "installed";
})()`;
const probeReset = () => ev(`(() => { const p = window.__soak; p.ticks = 0; p.maxGap = 0; p.since = Date.now(); p.last = Date.now(); return true; })()`);
const probeRead = () => ev(`(() => { const p = window.__soak; return { ticks: p.ticks, maxGap: p.maxGap, ms: Date.now() - p.since }; })()`);

// ---- the placer: a direct desktop-class client that holds orders on the market ----
const placer = { ws: null, orders: [], n: 0, hello: null };
const placerAlive = () => placer.ws && placer.ws.readyState === 1;
async function placerConnect() {
  if (placerAlive()) return;
  placer.orders = [];
  const w = new WebSocket(wsUrl, { headers: { "x-tradelayer-client": "desktop" } });
  placer.ws = w;
  w.onmessage = (m) => { try { const j = JSON.parse(String(m.data)); if (j.event === "connected") placer.hello = j; } catch (_) {} };
  await new Promise((res, rej) => {
    const t = setTimeout(() => { try { w.close(); } catch (_) {} rej(new Error("placer connect timed out")); }, 5000);
    w.onopen = () => { clearTimeout(t); res(); };
    w.onerror = () => { clearTimeout(t); rej(new Error("placer cannot connect")); };
  });
}
async function ensurePlacer(ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    try { await placerConnect(); return true; } catch (_) { if (Date.now() > end) return false; await sleep(500); }
  }
}
// Place one more SELL on the market with a price the UI has not shown yet; keep at most 4 open.
// `many-orders` makes the server tell the market's subscribers to ask for a fresh snapshot.
let markerSeq = 0;
async function placeMarker() {
  if (!(await ensurePlacer())) throw new Error("placer cannot reach the orderbook");
  const price = 1500 + (markerSeq++ % 400) + 0;
  const uuid = `soak-${Date.now()}-${markerSeq}`;
  const order = { uuid, side: "SELL", type: "SPOT", price, amount: 1, props: { id_for_sale: MARKET.quote, id_desired: MARKET.base, price, amount: 1 } };
  placer.ws.send(JSON.stringify({ event: "many-orders", network: NET, marketKey: MARKET.key, orders: [order] }));
  placer.orders.push({ uuid, price });
  while (placer.orders.length > 4) {
    const old = placer.orders.shift();
    placer.ws.send(JSON.stringify({ event: "close-order", orderUUID: old.uuid, marketKey: MARKET.key, network: NET }));
  }
  return price;
}
const bookShows = (st, price) => !!st && Array.isArray(st.book) && st.book.some((p) => Math.abs(p - price) < 0.00005);

// ---- recovery ----
async function recover(label, limitMs = 30000) {
  const start = Date.now();
  const at = { main: null, ob: null, block: null, book: null };
  // A fresh order placed now: the order book view must show it, whichever way it reaches the UI
  // (the update request, or the snapshot after the orderbook link rejoins its market).
  let marker = null;
  const markerPlaced = placeMarker().then((p) => { marker = p; }, (e) => log(`marker order not placed: ${e.message}`));
  const cpu0 = await cpuSnapshot().catch(() => new Map());
  let responsive = null;
  while (Date.now() - start < limitMs) {
    let st = null, h = null, relay = false;
    try { [st, h, relay] = await Promise.all([uiState(), chainHeight(), relayAlive()]); } catch (_) {}
    if (st) {
      const dt = Date.now() - start;
      if (responsive === null) responsive = dt;
      if (st.main && at.main === null) at.main = dt;
      if (st.ob && relay && at.ob === null) at.ob = dt;
      if (st.block === h && at.block === null) at.block = dt;
      if (marker !== null && bookShows(st, marker) && at.book === null) at.book = dt;
    }
    if (at.main !== null && at.ob !== null && at.block !== null && at.book !== null) break;
    await sleep(500);
  }
  void markerPlaced;
  const ok = at.main !== null && at.ob !== null && at.block !== null && at.book !== null;
  const fmt = (v) => (v === null ? "never" : `${(v / 1000).toFixed(1)}s`);
  recoveries.push({ label, ok, ...at });
  if (ok) await screenshot(`recovered-${recoveries.length}.png`);
  log(`${ok ? "RECOVERED" : "NOT RECOVERED"} after ${label}: main ${fmt(at.main)}, orderbook ${fmt(at.ob)}, block counter ${fmt(at.block)}, order book view ${fmt(at.book)}`);
  if (!ok) {
    // Diagnose: is the page busy, idle, or is the machine loaded? Then wait for it to answer.
    const cpu1 = await cpuSnapshot().catch(() => new Map());
    log(`diagnosis after ${label}: page answered ${responsive === null ? "not at all" : (responsive / 1000).toFixed(1) + " s after resume"} in the window; cpu ${cpuDelta(cpu0, cpu1)}; system load ${await systemLoad()} %`);
    const t1 = Date.now();
    while (Date.now() - t1 < 120000) {
      try { const st = await uiState(); log(`page answers ${((Date.now() - start) / 1000).toFixed(0)} s after resume: ${JSON.stringify(st)}; system load ${await systemLoad()} %`); break; } catch (_) { await sleep(1000); }
    }
    fail(`no recovery within ${limitMs / 1000}s after ${label}`);
  }
  return ok;
}

// ---- steps ----
async function holdWithMining(ms) { await sleep(ms); }
async function minimizeStep(holdMs, alsoFreeze) {
  state.disrupting = true;
  await probeReset().catch(() => {});
  const m = await setWindow(true);
  const vis = await ev("document.visibilityState", 8000).catch(() => "unreadable");
  log(`window minimized via ${m.how}: iconic=${m.iconic}, visibilityState=${vis}; holding ${Math.round(holdMs / 1000)} s${alsoFreeze ? " with the page frozen" : ""}`);
  if (alsoFreeze) { state.blind = true; await cdp("Page.setWebLifecycleState", { state: "frozen" }); }
  await holdWithMining(holdMs);
  if (alsoFreeze) { await cdp("Page.setWebLifecycleState", { state: "active" }); await sleep(300); }
  let timers = null;
  if (!alsoFreeze) {
    try { timers = await probeRead(); } catch (e) { fail(`timer probe unreadable while minimized: ${e.message}`); }
    if (timers) {
      const expected = timers.ms / 100;
      const ratio = timers.ticks / expected;
      log(`page timer while minimized: ${timers.ticks} ticks in ${(timers.ms / 1000).toFixed(0)} s (${(ratio * 100).toFixed(0)}% of 10 Hz), longest gap ${timers.maxGap} ms`);
      check("100 ms page timer keeps its rate while minimized", ratio >= 0.9 && timers.maxGap <= 1000, `${(ratio * 100).toFixed(0)}% / max gap ${timers.maxGap} ms`);
    }
  }
  const r = await setWindow(false);
  log(`window restored via ${r.how}: iconic=${r.iconic}`);
  state.blind = false;
  await recover(`${alsoFreeze ? "minimize+freeze" : "minimize"} ${Math.round(holdMs / 1000)}s`);
  state.disrupting = false;
}
async function freezeStep(holdMs) {
  state.disrupting = true;
  state.blind = true;
  await cdp("Page.setWebLifecycleState", { state: "frozen" });
  log(`page frozen; holding ${Math.round(holdMs / 1000)} s (main socket session expires on the Rust side after 45 s)`);
  await holdWithMining(holdMs);
  await cdp("Page.setWebLifecycleState", { state: "active" });
  log("page resumed");
  state.blind = false;
  await recover(`freeze ${Math.round(holdMs / 1000)}s`);
  state.disrupting = false;
}
async function orderbookRestartStep() {
  const stopCmd = process.env.OB_STOP_CMD, startCmd = process.env.OB_START_CMD;
  if (!stopCmd || !startCmd) { log("orderbook restart skipped (OB_STOP_CMD and OB_START_CMD not both set)"); return; }
  state.disrupting = true;
  await run("cmd.exe", ["/c", stopCmd]).catch((e) => log(`stop command: ${e.message.slice(0, 200)}`));
  log("orderbook server stopped; down for 10 s");
  await sleep(10000);
  await run("cmd.exe", ["/c", startCmd]).catch((e) => log(`start command: ${e.message.slice(0, 200)}`));
  log("orderbook start command ran");
  let up = false;
  for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(`http://${new URL(wsUrl).host}/markets/spot/${NET}`)).ok; } catch (_) {} if (!up) await sleep(500); }
  log(up ? "orderbook server answers again" : "orderbook server did not come back");
  if (!up) fail("orderbook start command did not bring the server back");
  // The placer's socket died with the server, and its orders with it.
  try { placer.ws && placer.ws.close(); } catch (_) {}
  placer.ws = null;
  const restartedAt = Date.now();
  await recover("orderbook restart", 60000);
  log(`orderbook UI state ${(Date.now() - restartedAt) / 1000}s after restart: ${JSON.stringify(await uiState().catch(() => null))}`);
  state.disrupting = false;
}

// ---- background loops ----
async function minerLoop(addr) {
  while (!minerStop) {
    await sleep(20000);
    if (minerStop) break;
    let h;
    try { await cli("generatetoaddress", "1", addr); h = await chainHeight(); } catch (e) { fail(`mining failed: ${e.message}`); continue; }
    const start = Date.now();
    let seen = null;
    const blind = state.blind;
    while (!blind && Date.now() - start < 10000) {
      try { const st = await uiState(); if (st.block >= h) { seen = Date.now() - start; break; } } catch (_) {}
      await sleep(400);
    }
    if (blind || state.blind) { log(`block ${h} mined while the page is frozen (not asserted)`); continue; }
    if (seen === null) {
      if (state.disrupting) { log(`block ${h}: UI counter late during a disruption (recovery check decides)`); continue; }
      fail(`UI block counter did not reach ${h} within 10 s`);
    } else { blockLags.push(seen); log(`block ${h}: UI followed in ${(seen / 1000).toFixed(1)} s`); }
  }
}
async function bookLoop() {
  await sleep(10000);
  while (!minerStop) {
    await sleep(20000);
    if (minerStop) break;
    if (state.blind || state.disrupting) continue;
    let price;
    try { price = await placeMarker(); } catch (e) { fail(`placer: ${e.message}`); continue; }
    const start = Date.now();
    let seen = null;
    while (Date.now() - start < 10000) {
      if (state.blind || state.disrupting) break;
      try { if (bookShows(await uiState(), price)) { seen = Date.now() - start; break; } } catch (_) {}
      await sleep(300);
    }
    if (state.blind || state.disrupting) { log(`order ${price} placed while a disruption began (not asserted)`); continue; }
    if (seen === null) fail(`order book view did not show the new order ${price} within 10 s`);
    else { bookLags.push(seen); log(`order ${price}: order book view showed it in ${(seen / 1000).toFixed(1)} s`); }
  }
}
async function memLoop() {
  while (!memStop) { await sleep(60000); if (memStop) break; try { await sampleMemory(); } catch (e) { log(`memory sample failed: ${e.message}`); } }
}

// ---- main ----
const cfgPath = join(datadir, "desktop-config.json");
let minerPromise = null, memPromise = null;
try {
  for (let i = 0; ; i++) {
    try { execFileSync(join(BIN, "bitcoin-cli.exe"), [...cliArgs, "getblockchaininfo"], { stdio: "ignore" }); break; }
    catch (e) { if (i > 80) throw e; await sleep(250); }
  }
  cliSync("createwallet", "miner");
  const minerAddr = cliSync("-rpcwallet=miner", "getnewaddress");
  cliSync("generatetoaddress", "3", minerAddr);
  writeFileSync(join(nodeConfDir, "litecoin.conf"), `rpcuser=${RPC_USER}\nrpcpassword=${RPC_PASS}\nrpcport=${RPC_PORT}\n`);
  writeFileSync(cfgPath, JSON.stringify({
    network: "BTCREGTEST", node_url: `http://127.0.0.1:${RPC_PORT}`, rpc_user: RPC_USER, rpc_password: RPC_PASS,
    data_dir: join(datadir, "desktop-data"), node_data_dir: nodeConfDir, orderbook_urls: [obOrigin],
  }));
  log(`soak start: ${MINUTES} min (scale ${SCALE.toFixed(2)}), exe ${exe}, orderbook ${obOrigin}, restart commands ${process.env.OB_STOP_CMD && process.env.OB_START_CMD ? "given" : "absent"}`);

  app = spawn(exe, [], {
    env: {
      ...process.env, TL_DESKTOP_CONFIG: cfgPath, WEBVIEW2_USER_DATA_FOLDER: join(datadir, "webview2"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: "ignore",
  });
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === "page"); } catch (_) {}
    if (!page) await sleep(250);
  }
  if (!page) throw new Error("no WebView2 page target");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === "Runtime.exceptionThrown") pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  };
  await cdp("Runtime.enable");
  await cdp("Page.enable");

  // The window flags from tauri.conf.json must have reached the WebView2 browser process.
  const rows = subtree(await processTable(), app.pid);
  const cmdlines = rows.map((r) => r.CommandLine || "").filter((c) => /msedgewebview2/i.test(c));
  const missing = REQUIRED_FLAGS.filter((f) => !cmdlines.some((c) => c.includes(f)));
  check("WebView2 runs with the throttling flags from tauri.conf.json", cmdlines.length > 0 && missing.length === 0, missing.length ? `missing ${missing.join(" ")}` : `${cmdlines.length} processes`);
  check("remote debugging flag from the environment is present too", cmdlines.some((c) => c.includes(`--remote-debugging-port=${CDP_PORT}`)));

  check("FE-speed UI shows Select Network", await waitFor(`[...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Select Network")`, 30000));
  await ev(`(() => { const b = [...document.querySelectorAll("button")].filter((x) => x.innerText.trim() === "Select Network"); b[b.length - 1].click(); return true; })()`);
  check("Start Node clicked", await waitFor(`(() => { const b = [...document.querySelectorAll("button")].find(b => /start node/i.test(b.innerText) && !b.disabled); if (!b) return false; b.click(); return true; })()`, 15000));
  check("menu shows Spot Trading", await waitFor(`document.body.innerText.includes("Spot Trading")`, 30000));
  check("node synced", await waitFor(`document.body.innerText.includes("SYNCED")`, 30000));
  // Servers window: the custom entry of the orderbook list takes the ws URL.
  const selected = await ev(`(() => { const input = [...document.querySelectorAll("input.input_url")][0]; if (!input) return "no custom input"; input.closest(".server").click(); return "selected"; })()`);
  await sleep(400);
  const typed = await ev(`(() => { const input = [...document.querySelectorAll("input.input_url")][0]; if (!input || input.disabled) return "input disabled"; input.value = ${JSON.stringify(wsUrl)}; input.dispatchEvent(new Event("input", { bubbles: true })); return "typed"; })()`);
  const clicked = await ev(`(() => { const b = [...document.querySelectorAll("button")].filter(b => b.innerText.trim() === "Connect")[0]; if (!b) return false; b.click(); return true; })()`);
  check("Connect clicked for the orderbook", clicked && typed === "typed", `${selected} ${typed}`);
  check("orderbook connected", await waitFor(`[...document.querySelectorAll("button")].some(b => b.innerText.trim() === "disconnect")`, 15000));
  check("the app holds a WebSocket to the orderbook", await relayAlive());
  // Spot Trading on TLTC/USDTt with a placer that holds an order.
  check("placer connected", await ensurePlacer());
  await sleep(500);
  check("placer hello says desktop", placer.hello?.clientClass === "desktop", JSON.stringify(placer.hello));
  check("Spot Trading opened", await ev(`(() => { const e = [...document.querySelectorAll("a,div,span,li,button")].filter((x) => x.innerText && x.innerText.trim() === "Spot Trading"); if (!e.length) return false; e[e.length - 1].click(); return true; })()`));
  check("market tabs listed", await waitFor(`document.body.innerText.includes(${JSON.stringify(MARKET.pair)})`, 20000));
  // Select another market and back: the UI joins the market and asks for its snapshot.
  await ev(`(() => { const e = [...document.querySelectorAll("button,div,span")].filter((x) => x.innerText && x.innerText.trim() === "TLt/LTC"); if (e.length) e[e.length - 1].click(); return true; })()`);
  await sleep(1500);
  await ev(`(() => { const e = [...document.querySelectorAll("button,div,span")].filter((x) => x.innerText && x.innerText.trim() === ${JSON.stringify(MARKET.pair)}); e[e.length - 1].click(); return true; })()`);
  await sleep(1500);
  // Minimize the Synchronization window so the page is in view (the bottom tab toggles it).
  await ev(`(() => { const e = [...document.querySelectorAll("*")].filter((x) => x.children.length === 0 && x.innerText && x.innerText.trim() === "Synchronization"); const t = e[e.length - 1]; if (t) t.click(); return !!t; })()`);
  const base = await placeMarker();
  check("order book view shows the placer's first order", await waitFor(`(() => { const c = document.querySelector("tl-spot-orderbook-card"); return !!c && c.innerText.includes(${JSON.stringify(base.toFixed(4))}); })()`, 15000), String(base));
  log(`probe: ${await ev(PROBE_INSTALL)}`);
  const first = await uiState();
  check("baseline: main socket, orderbook and block counter", first.main && first.ob && first.block === (await chainHeight()), JSON.stringify(first));
  check("baseline: the app holds a connection to the orderbook", await relayAlive());
  check("baseline: order book view", bookShows(first, base) || bookShows(await uiState(), base), JSON.stringify(first.book));
  if (failures.length) throw new Error("baseline failed");
  await sampleMemory();
  if (process.env.SOAK_BASELINE_ONLY) {
    const more = [await placeMarker(), await placeMarker(), await placeMarker()];
    const all = [base, ...more];
    const shown = await waitFor(`(() => { const c = document.querySelector("tl-spot-orderbook-card"); return !!c && ${JSON.stringify(all.map((p) => p.toFixed(4)))}.every((p) => c.innerText.includes(p)); })()`, 15000);
    check("order book view shows all the orders the placer placed", shown, JSON.stringify(all));
    await screenshot("fe-speed-orderbook.png");
    throw new Done();
  }

  minerPromise = minerLoop(minerAddr);
  const bookPromise = bookLoop();
  memPromise = memLoop();

  // Schedule (minutes at full scale), each step waits for the previous one to finish.
  const hold = (s) => Math.max(15000, Math.round(s * 1000 * SCALE));
  let plan = [
    [3, "minimize", hold(150)], [8, "freeze", hold(150)], [13, "obrestart"], [17, "minimize+freeze", hold(180)],
    [23, "minimize", hold(180)], [29, "freeze", hold(180)], [35, "minimize", hold(360)],
  ];
  if (process.env.SOAK_PLAN) {
    // e.g. SOAK_PLAN=freeze:180,freeze:180,minimize:120 : back to back, one minute apart, unscaled.
    plan = process.env.SOAK_PLAN.split(",").map((x, i) => { const [k, sec] = x.split(":"); return [(i + 1) / SCALE, k, Number(sec || 0) * 1000]; });
  }
  const endAt = t0 + MINUTES * 60000;
  let lastEnd = Date.now();
  for (const [atMin, kind, holdMs] of plan) {
    const due = Math.max(t0 + atMin * SCALE * 60000, lastEnd + 20000);
    if (due + (holdMs || 20000) + 35000 > endAt) { log(`step ${kind} at ${atMin} min does not fit in ${MINUTES} min; skipped`); continue; }
    await sleep(Math.max(0, due - Date.now()));
    if (kind === "minimize") await minimizeStep(holdMs, false);
    else if (kind === "minimize+freeze") await minimizeStep(holdMs, true);
    else if (kind === "freeze") await freezeStep(holdMs);
    else await orderbookRestartStep();
    lastEnd = Date.now();
  }
  await sleep(Math.max(0, endAt - Date.now()));
  minerStop = true; memStop = true;
  await Promise.race([Promise.all([minerPromise, bookPromise]), sleep(30000)]);
  await recover("end of run", 15000);
  await sampleMemory();

  // Memory: least-squares slope after warm-up (first 10 %, at least 3 min) over total working set.
  const warm = Math.max(3, MINUTES * 0.1);
  const pts = memSamples.filter((s) => s.min >= warm && s.steady);
  if (pts.length >= 4) {
    const n = pts.length, mx = pts.reduce((a, p) => a + p.min, 0) / n, my = pts.reduce((a, p) => a + p.totalMb, 0) / n;
    const slope = pts.reduce((a, p) => a + (p.min - mx) * (p.totalMb - my), 0) / pts.reduce((a, p) => a + (p.min - mx) ** 2, 0);
    const growth = pts[pts.length - 1].totalMb - pts[0].totalMb;
    check(`memory slope under ${MEM_SLOPE_LIMIT} MB/min after warm-up`, slope <= MEM_SLOPE_LIMIT, `slope ${slope.toFixed(3)} MB/min over ${n} samples, ${growth.toFixed(1)} MB net`);
  } else {
    log(`memory slope not judged: ${pts.length} steady samples after warm-up (needs 4)`);
  }
  check("no uncaught page exceptions", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | ").slice(0, 600));
} catch (e) {
  if (!(e instanceof Done)) fail(`run aborted: ${e.stack || e}`);
} finally {
  minerStop = true; memStop = true;
  try { ws && ws.close(); } catch (_) {}
  if (app) killTree(app.pid);
  try { placer.ws && placer.ws.close(); } catch (_) {}
  try { cliSync("stop"); } catch (_) {}
  for (let i = 0; i < 40 && node.exitCode === null; i++) await sleep(250);
  try { rmSync(datadir, { recursive: true, force: true }); } catch (_) {}
  console.log("\n=== timeline summary ===");
  console.log(`recoveries: ${recoveries.length}`);
  for (const r of recoveries) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.label}: main ${r.main === null ? "never" : (r.main / 1000).toFixed(1) + "s"}, orderbook ${r.ob === null ? "never" : (r.ob / 1000).toFixed(1) + "s"}, block ${r.block === null ? "never" : (r.block / 1000).toFixed(1) + "s"}, order book ${r.book === null ? "never" : (r.book / 1000).toFixed(1) + "s"}`);
  if (blockLags.length) {
    const s = [...blockLags].sort((a, b) => a - b);
    console.log(`blocks followed: ${s.length}, median ${(s[Math.floor(s.length / 2)] / 1000).toFixed(1)} s, max ${(s[s.length - 1] / 1000).toFixed(1)} s`);
  }
  if (bookLags.length) {
    const sb = [...bookLags].sort((a, b) => a - b);
    console.log(`orders shown: ${sb.length}, median ${(sb[Math.floor(sb.length / 2)] / 1000).toFixed(1)} s, max ${(sb[sb.length - 1] / 1000).toFixed(1)} s`);
  }
  if (memSamples.length) console.log(`memory MB (total): ${memSamples.map((s) => s.totalMb.toFixed(0)).join(" ")}`);
  if (process.env.SOAK_BASELINE_ONLY && failures.length === 0) console.log("E2E_FE_SPEED_OK");
  else console.log(failures.length === 0 ? "SOAK_OK" : `SOAK_FAIL ${failures.length}: ${failures.join(" | ").slice(0, 600)}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
