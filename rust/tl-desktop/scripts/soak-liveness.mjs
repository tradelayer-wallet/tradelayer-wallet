// Liveness soak of the original Angular UI inside tl-desktop. Windows: WebView2 + Bitcoin Core 31.1.
// Usage: node soak-liveness.mjs <tl-desktop.exe> <orderbook url> <minutes>
//
// The exe's CSP must allow the orderbook origin. Optional env:
//   OB_RESTART_CMD            shell command that starts the orderbook server again; with it the run
//                             kills the process listening on the orderbook port and restarts it once.
//   SOAK_MEM_SLOPE_MB_MIN     memory slope limit in MB/min after warm-up (default 1.0).
//   SOAK_PLAN                 replace the schedule, e.g. freeze:180,minimize:120,obrestart (unscaled).
//
// What it does: starts a throwaway bitcoind -regtest, launches the app with WebView2 remote
// debugging, drives Select Network / Start Node and connects the orderbook through the Servers
// window, then for <minutes>:
//   * mines a block every 20 s and requires the UI block counter to follow within 10 s;
//   * minimizes/restores the window and freezes/resumes the page (Page.setWebLifecycleState),
//     holding each 2-3 minutes at full scale (45 min), and restarts the orderbook once;
//     after each disruption the main socket, the orderbook and the block counter must be
//     current again within 30 s;
//   * while minimized a 100 ms page timer must keep its rate (the backgroundThrottling
//     replacement: the WebView2 flags in tauri.conf.json; one hold of 6 minutes also covers
//     Chromium's intensive throttling, which starts after 5 minutes hidden);
//   * samples the working set of the app and its WebView2 processes every minute and fails on a
//     memory slope above the limit (samples taken during a disruption are listed but not used:
//     Windows trims the working set of a frozen or minimized page).
// Prints a timeline and SOAK_OK or SOAK_FAIL.
import { spawn, execFileSync, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [exe, obUrl, minutesArg] = process.argv.slice(2);
const MINUTES = Number(minutesArg);
if (!exe || !obUrl || !(MINUTES > 0)) {
  console.error("usage: node soak-liveness.mjs <tl-desktop.exe> <orderbook url> <minutes>");
  process.exit(2);
}
const BIN = join(process.env.LOCALAPPDATA, "Programs/BitcoinCore/bitcoin-31.1/bin");
const RPC_PORT = 18995, CDP_PORT = 9347;
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
const state = { blind: false, disrupting: false };

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
const waitFor = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 250) { try { if (await ev(expr)) return true; } catch (_) {} await sleep(250); } return false; };
const clickText = (t, sel = "button, a, span, div, li") => ev(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.innerText && e.innerText.trim() === ${JSON.stringify(t)}); const e = els[els.length - 1]; if (!e) return false; e.click(); return true; })()`);

const UI_STATE = `(() => ({
  main: !document.body.innerText.includes("No connection with local server"),
  ob: [...document.querySelectorAll("button")].some(b => b.innerText.trim() === "disconnect"),
  block: parseInt((document.querySelector(".block-container .block") || {}).innerText || "", 10),
  vis: document.visibilityState,
}))()`;
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
// (the Rust relay client long-polls the orderbook, so a live relay has one open).
async function relayAlive() {
  const port = new URL(obUrl).port;
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

// ---- recovery ----
async function recover(label, limitMs = 30000) {
  const start = Date.now();
  const at = { main: null, ob: null, block: null };
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
    }
    if (at.main !== null && at.ob !== null && at.block !== null) break;
    await sleep(500);
  }
  const ok = at.main !== null && at.ob !== null && at.block !== null;
  const fmt = (v) => (v === null ? "never" : `${(v / 1000).toFixed(1)}s`);
  recoveries.push({ label, ok, ...at });
  log(`${ok ? "RECOVERED" : "NOT RECOVERED"} after ${label}: main ${fmt(at.main)}, orderbook ${fmt(at.ob)}, block counter ${fmt(at.block)}`);
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
  const cmd = process.env.OB_RESTART_CMD;
  if (!cmd) { log("orderbook restart skipped (OB_RESTART_CMD not set)"); return; }
  state.disrupting = true;
  const port = Number(new URL(obUrl).port);
  const pid = await pidOnPort(port);
  if (!pid) { fail(`no process listens on orderbook port ${port}`); state.disrupting = false; return; }
  killTree(pid);
  log(`orderbook server killed (pid ${pid}); down for 10 s`);
  await sleep(10000);
  spawn(cmd, { shell: true, detached: true, stdio: "ignore" }).unref();
  log("orderbook restart command started");
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${obUrl}/socket.io/?EIO=4&transport=polling`)).ok; } catch (_) {} if (!up) await sleep(500); }
  log(up ? "orderbook server answers again" : "orderbook server did not come back");
  if (!up) fail("orderbook restart command did not bring the server back");
  const restartedAt = Date.now();
  await recover("orderbook restart");
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
    data_dir: join(datadir, "desktop-data"), node_data_dir: nodeConfDir, orderbook_urls: [obUrl],
  }));
  log(`soak start: ${MINUTES} min (scale ${SCALE.toFixed(2)}), exe ${exe}, orderbook ${obUrl}, restart command ${process.env.OB_RESTART_CMD ? "given" : "absent"}`);

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

  check("original UI shows Select Network", await waitFor(`document.body.innerText.includes("Select Network")`));
  await clickText("Select Network", "button");
  check("menu shows Spot Trading", await waitFor(`document.body.innerText.includes("Spot Trading")`, 10000));
  check("Start Node clicked", await ev(`(() => { const b = [...document.querySelectorAll("button")].find(b => /start node/i.test(b.innerText)); if (!b) return false; b.click(); return true; })()`));
  check("node synced", await waitFor(`document.body.innerText.includes("SYNCED")`, 30000));
  check("Servers tab present", await clickText("Servers"));
  await sleep(800);
  check("Servers window lists the orderbook servers", await waitFor(`document.body.innerText.includes("Orderbook Servers")`, 5000));
  const selected = await ev(`(() => { const input = [...document.querySelectorAll("input.input_url")][0]; if (!input) return "no custom input"; input.closest(".server").click(); return "selected"; })()`);
  await sleep(300);
  const typed = await ev(`(() => { const input = [...document.querySelectorAll("input.input_url")][0]; if (!input || input.disabled) return "input disabled"; input.value = ${JSON.stringify(obUrl)}; input.dispatchEvent(new Event("input", { bubbles: true })); return "typed"; })()`);
  const clicked = await ev(`(() => { const b = [...document.querySelectorAll("button")].filter(b => b.innerText.trim() === "Connect")[0]; if (!b) return false; b.click(); return true; })()`);
  check("Connect clicked for the orderbook", clicked && typed === "typed", `${selected} ${typed}`);
  check("orderbook connected", await waitFor(`[...document.querySelectorAll("button")].some(b => b.innerText.trim() === "disconnect")`, 15000));
  log(`probe: ${await ev(PROBE_INSTALL)}`);
  const first = await uiState();
  check("baseline: main socket, orderbook and block counter", first.main && first.ob && first.block === (await chainHeight()), JSON.stringify(first));
  check("baseline: the app holds a connection to the orderbook", await relayAlive());
  if (failures.length) throw new Error("baseline failed");
  await sampleMemory();

  minerPromise = minerLoop(minerAddr);
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
  await Promise.race([minerPromise, sleep(30000)]);
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
  fail(`run aborted: ${e.stack || e}`);
} finally {
  minerStop = true; memStop = true;
  try { ws && ws.close(); } catch (_) {}
  if (app) killTree(app.pid);
  if (process.env.OB_RESTART_CMD) { /* the caller owns the orderbook server */ }
  try { cliSync("stop"); } catch (_) {}
  for (let i = 0; i < 40 && node.exitCode === null; i++) await sleep(250);
  try { rmSync(datadir, { recursive: true, force: true }); } catch (_) {}
  console.log("\n=== timeline summary ===");
  console.log(`recoveries: ${recoveries.length}`);
  for (const r of recoveries) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.label}: main ${r.main === null ? "never" : (r.main / 1000).toFixed(1) + "s"}, orderbook ${r.ob === null ? "never" : (r.ob / 1000).toFixed(1) + "s"}, block ${r.block === null ? "never" : (r.block / 1000).toFixed(1) + "s"}`);
  if (blockLags.length) {
    const s = [...blockLags].sort((a, b) => a - b);
    console.log(`blocks followed: ${s.length}, median ${(s[Math.floor(s.length / 2)] / 1000).toFixed(1)} s, max ${(s[s.length - 1] / 1000).toFixed(1)} s`);
  }
  if (memSamples.length) console.log(`memory MB (total): ${memSamples.map((s) => s.totalMb.toFixed(0)).join(" ")}`);
  console.log(failures.length === 0 ? "SOAK_OK" : `SOAK_FAIL ${failures.length}: ${failures.join(" | ").slice(0, 600)}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
