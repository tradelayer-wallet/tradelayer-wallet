// tl-desktop with TradeLayer-Rust's tradelayer-node as its listener sidecar, against a real Bitcoin Core
// testnet4 node. Windows: WebView2 + Bitcoin Core with testnet4 RPC on loopback and cookie auth.
// Usage: node e2e-node-sidecar.mjs <tl-desktop.exe> <tradelayer-node.exe>
//   env TL_NODE_RPC     Core RPC IP:PORT (default 127.0.0.1:48332, the testnet4 port)
//       TL_NODE_COOKIE  absolute path of Core's .cookie (default C:/BitcoinTestnet/testnet4/.cookie)
//       TL_NODE_BEHIND  blocks between the anchor and Core's tip (default 12)
//
// The cookie is passed to bitcoin-cli and to the node as a path; this script never reads it.
// What it does, in a fresh temp dir:
//   1. writes a listenerd config and a source config whose pins come from
//      `tradelayer-node --print-bootstrap-commitments`;
//   2. initializes the node store with `--initialize --anchor-height/--anchor-hash` at tip - BEHIND and
//      `--max-blocks 2`, which applies two blocks and exits 0;
//   3. starts tl-desktop with `tl_engine = "tradelayer-node"`: the app starts the node as its sidecar
//      (no anchor or initialize flags), and the node resumes and applies the remaining blocks to the tip;
//   4. requires the node's own `GET /initstatus` to report authenticated_admission:true and the app's
//      `/tlraw/tl_getMaxProcessedHeight` to reach Core's tip height (absolute heights), and an
//      `rpc-call` of tl_check_kyc to be answered by the node in the {data} envelope;
//   5. closes the window: the app must stop the node through its stop file inside the grace period, and the
//      store must restart cleanly without --initialize and exit 0 on its own stop file.
// Prints E2E_NODE_SIDECAR_OK or E2E_NODE_SIDECAR_FAIL.
import { spawn, execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const [exe, nodeExe] = process.argv.slice(2);
if (!exe || !nodeExe) {
  console.error("usage: node e2e-node-sidecar.mjs <tl-desktop.exe> <tradelayer-node.exe>");
  process.exit(2);
}
const RPC = process.env.TL_NODE_RPC || "127.0.0.1:48332";
const COOKIE = process.env.TL_NODE_COOKIE || "C:/BitcoinTestnet/testnet4/.cookie";
const BEHIND = Number(process.env.TL_NODE_BEHIND || 12);
const CLI = join(process.env.LOCALAPPDATA, "Programs/BitcoinCore/bitcoin-31.1/bin/bitcoin-cli.exe");
const [rpcHost, rpcPort] = RPC.split(":");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); if (!ok) failures.push(name); return ok; };
const cli = (...a) => execFileSync(CLI, [`-rpcconnect=${rpcHost}`, `-rpcport=${rpcPort}`, `-rpccookiefile=${COOKIE}`, ...a], { encoding: "utf8" }).trim();
const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { encoding: "utf8", maxBuffer: 16 << 20, ...opts }, (e, out, err) => res({ code: e ? e.code ?? 1 : 0, out, err })));
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const procExists = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const nodePids = () => {
  try {
    return execFileSync("tasklist", ["/FI", "IMAGENAME eq tradelayer-node.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" })
      .split("\n").map((l) => l.split(",")[1]).filter(Boolean).map((s) => Number(s.replace(/"/g, "")));
  } catch (_) { return []; }
};

const dir = mkdtempSync(join(tmpdir(), "tl-node-e2e-"));
const p = (f) => join(dir, f).replace(/\\/g, "/");
let app = null;
try {
  const info = JSON.parse(cli("getblockchaininfo"));
  check("Core is testnet4 and synced", info.chain === "testnet4" && !info.initialblockdownload, `${info.chain} ${info.blocks}`);
  const tip = info.blocks;
  const anchorHeight = tip - BEHIND;
  const anchorHash = cli("getblockhash", String(anchorHeight));

  // 1. configs
  writeFileSync(p("listenerd.conf"), [
    "format = tradelayer-listenerd-config-v1", "network = bitcoin", "admin = E2eAdmin", "contract = 1", "collateral = 7",
    "permitted_spot_properties = 7", "rollback_limit = 16", "inverse = false", "notional = 1",
    "initial_margin_per_contract = 10000", "fee_route = oracle:1", "marking = none", "",
  ].join("\n"));
  const pins = await run(nodeExe, ["--print-bootstrap-commitments", "--config", p("listenerd.conf"), "--collateral-seed-atoms", "100000000"]);
  check("bootstrap commitments printed", pins.code === 0, (pins.err || "").trim().slice(0, 300));
  const pinLines = pins.out.split(/\r?\n/).filter((l) => /^(bootstrap_commitment|catalog_bootstrap_commitment)\s*=/.test(l.trim()));
  let pinPairs = pinLines.map((l) => l.trim());
  if (pinPairs.length !== 2) {
    // a JSON line instead of key = value lines
    try {
      const j = JSON.parse(pins.out.trim().split(/\r?\n/).pop());
      pinPairs = [`bootstrap_commitment = ${j.bootstrap_commitment ?? j.bootstrapCommitment}`, `catalog_bootstrap_commitment = ${j.catalog_bootstrap_commitment ?? j.catalogBootstrapCommitment}`];
    } catch (_) {}
  }
  check("two bootstrap pins", pinPairs.length === 2 && pinPairs.every((l) => /= [0-9a-f]{64}$/.test(l)), pins.out.trim().slice(0, 300));
  writeFileSync(p("source.conf"), [
    "format = tradelayer-node-source-v1", "policy = conserving-sequential-v2", "block_mode = realtime",
    "bootstrap = collateral-seed", "collateral_seed_atoms = 100000000", ...pinPairs, "",
  ].join("\n"));

  // 2. initialize at tip - BEHIND, apply two blocks
  mkdirSync(p("store"));
  const common = ["--root", p("store"), "--network", "BTC-TESTNET4", "--rpc-address", RPC, "--cookie-file", COOKIE,
    "--config", p("listenerd.conf"), "--source-config", p("source.conf"), "--head-log", p("observer.head")];
  const initPort = await freePort();
  const init = await run(nodeExe, [...common, "--initialize", "--anchor-height", String(anchorHeight), "--anchor-hash", anchorHash,
    "--max-blocks", "2", "--bind", `127.0.0.1:${initPort}`, "--stop-file", p("init.stop")], { timeout: 180000 });
  const initBlocks = init.out.split(/\r?\n/).filter((l) => l.includes('"event":"block"')).length;
  check("node initializes at the anchor and applies 2 blocks", init.code === 0 && initBlocks === 2, `exit ${init.code}, ${initBlocks} block events; ${(init.err || "").trim().slice(0, 400)}`);

  // 3. the app with the node as its sidecar
  const lport = await freePort(), cdp = await freePort();
  const stopFile = p("node.stop");
  const cfg = p("desktop-config.json");
  writeFileSync(cfg, JSON.stringify({
    network: "BTCTEST", node_url: `http://${RPC}`, rpc_cookie_file: COOKIE, data_dir: p("desktop-data"), orderbook_urls: [],
    tl_listener_url: `http://127.0.0.1:${lport}`, tl_engine: "tradelayer-node",
    tl_node: {
      cmd: nodeExe.replace(/\\/g, "/"), root: p("store"), network: "BTC-TESTNET4", rpc_address: RPC, cookie_file: COOKIE,
      config: p("listenerd.conf"), source_config: p("source.conf"), head_log: p("observer.head"), stop_file: stopFile,
      rpc_timeout_ms: 10000, stop_grace_ms: 15000,
    },
  }, null, 1));
  const before = new Set(nodePids());
  app = spawn(exe, [], {
    env: { ...process.env, TL_DESKTOP_CONFIG: cfg, WEBVIEW2_USER_DATA_FOLDER: p("webview"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdp}` },
    stdio: "ignore",
  });
  let page;
  for (let i = 0; i < 160 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${cdp}/json`)).json()).find((x) => x.type === "page"); } catch (_) {}
    if (!page) await sleep(250);
  }
  if (!check("app window up", !!page)) throw new Error("no webview page");
  const sidecar = nodePids().filter((x) => !before.has(x));
  check("app started one tradelayer-node sidecar", sidecar.length === 1, `new pids ${sidecar.join(",")}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const post = (path, body) => ev(`fetch("http://tlapi.localhost${path}", {method: "POST", headers: {"content-type": "application/json"}, body: ${JSON.stringify(JSON.stringify(body))}}).then(async r => ({status: r.status, body: await r.text()}))`);

  // 4. the node catches up to Core's tip; the app's listener routes answer from it
  const target = Number(cli("getblockcount"));
  let status = null, height = null;
  for (let i = 0; i < 240; i++) {
    try { status = await (await fetch(`http://127.0.0.1:${lport}/initstatus`)).json(); } catch (_) {}
    try { const r = await post("/tlraw/tl_getMaxProcessedHeight", {}); if (r.status === 200) height = JSON.parse(r.body); } catch (_) {}
    const h = typeof height === "number" ? height : Number(height?.maxProcessedHeight ?? NaN);
    if (status?.authenticated_admission === true && h >= target) break;
    await sleep(500);
  }
  check("node status: authenticated_admission true after admitted blocks", status?.authenticated_admission === true, JSON.stringify(status).slice(0, 400));
  const h = typeof height === "number" ? height : Number(height?.maxProcessedHeight ?? NaN);
  check("app /tlraw/tl_getMaxProcessedHeight reaches Core's tip (absolute height)", h >= target, `listener ${JSON.stringify(height)}, Core ${target}`);
  const kyc = await post("/api/rpc-call", { method: "tl_check_kyc", params: ["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"] });
  check("rpc-call tl_check_kyc answered by the node in the {data} envelope", kyc.status === 200 && /"result: ":"(disabled|enabled)/.test(kyc.body), `${kyc.status} ${kyc.body.slice(0, 200)}`);
  const commits = await post("/api/rpc-call", { method: "tl_check_commits", params: ["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"] });
  check("rpc-call tl_check_commits answered by the node", commits.status === 200 && /^\{"data":\[/.test(commits.body), `${commits.status} ${commits.body.slice(0, 200)}`);
  ws.close();

  // 5. closing the window stops the node through its stop file. The app removes the stop file after the
  // child exits and kills it only after stop_grace_ms (15 s), so an exit well inside the grace period is
  // the node's own exit on the stop file; a clean restart of the same store shows it left the store whole.
  const closeAt = Date.now();
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid}).CloseMainWindow() | Out-Null`]);
  for (let i = 0; i < 120 && (procExists(app.pid) || sidecar.some(procExists)); i++) await sleep(250);
  const closeMs = Date.now() - closeAt;
  check("app exited on window close", !procExists(app.pid));
  check("sidecar stopped with the app, inside the 15 s grace period", !sidecar.some(procExists) && closeMs < 12000, `${closeMs} ms`);
  check("app removed the stop file after the node exited", !existsSync(stopFile));
  app = null;
  const rport = await freePort();
  const restart = spawn(nodeExe, [...common, "--bind", `127.0.0.1:${rport}`, "--stop-file", p("restart.stop")], { stdio: ["ignore", "pipe", "pipe"] });
  let rout = "", rerr = "";
  restart.stdout.on("data", (d) => (rout += d));
  restart.stderr.on("data", (d) => (rerr += d));
  const rexit = new Promise((r) => restart.on("exit", (c) => r(c)));
  let rstatus = null;
  for (let i = 0; i < 120 && !rstatus; i++) {
    try { rstatus = await (await fetch(`http://127.0.0.1:${rport}/initstatus`)).json(); } catch (_) {}
    if (!rstatus) await sleep(250);
  }
  writeFileSync(p("restart.stop"), "stop");
  const rcode = await Promise.race([rexit, sleep(20000).then(() => "timeout")]);
  check("node restarts from the stopped store and exits 0 on its stop file", rstatus?.initialized === true && rcode === 0,
    `exit ${rcode}; ${JSON.stringify(rstatus)?.slice(0, 200)}; ${rerr.trim().slice(0, 300)}`);
  if (rcode === "timeout") restart.kill();
} catch (e) {
  check("run", false, e.message);
} finally {
  if (app && procExists(app.pid)) { try { execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" }); } catch (_) {} }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
}
console.log(failures.length ? `E2E_NODE_SIDECAR_FAIL (${failures.join("; ")})` : "E2E_NODE_SIDECAR_OK");
process.exit(failures.length ? 1 : 0);
