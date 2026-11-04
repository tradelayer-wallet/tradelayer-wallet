// Regtest run of the ORIGINAL Angular wallet UI (packages/wallet-fe) inside tl-desktop, driven
// through the page over the WebView2 DevTools protocol (Windows: WebView2 + Bitcoin Core 31.1).
// Usage: node e2e-legacy-ui.mjs <tl-desktop.exe built with dist-ui> <out dir>
// Starts a throwaway bitcoind -regtest with synthetic RPC credentials; touches no other node.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [exe, outDir] = process.argv.slice(2);
const BIN = join(process.env.LOCALAPPDATA, "Programs/BitcoinCore/bitcoin-31.1/bin");
const RPC_PORT = 18997, CDP_PORT = 9342;
const RPC_USER = "e2euser", RPC_PASS = "e2e-synthetic-rpc-password";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); if (!ok) failures++; };

mkdirSync(outDir, { recursive: true });
const datadir = mkdtempSync(join(tmpdir(), "tl-desktop-legacy-e2e-"));
const nodeConfDir = join(datadir, "litecoin-datadir");
mkdirSync(nodeConfDir);
const cliArgs = [`-datadir=${datadir}`, "-regtest", `-rpcport=${RPC_PORT}`, `-rpcuser=${RPC_USER}`, `-rpcpassword=${RPC_PASS}`];
const cli = (...a) => execFileSync(join(BIN, "bitcoin-cli.exe"), [...cliArgs, ...a], { encoding: "utf8" }).trim();
const node = spawn(join(BIN, "bitcoind.exe"), [
  `-datadir=${datadir}`, "-regtest", "-listen=0", `-rpcport=${RPC_PORT}`, `-rpcuser=${RPC_USER}`, `-rpcpassword=${RPC_PASS}`,
  "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1",
], { stdio: "ignore" });
let app = null;
const killTree = (p) => { try { execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch (_) {} };

try {
  for (let i = 0; ; i++) {
    try { execFileSync(join(BIN, "bitcoin-cli.exe"), [...cliArgs, "getblockchaininfo"], { stdio: "ignore" }); break; }
    catch (e) { if (i > 80) throw e; await sleep(250); }
  }
  cli("createwallet", "miner");
  const minerAddr = cli("-rpcwallet=miner", "getnewaddress");
  cli("generatetoaddress", "5", minerAddr);

  // The legacy UI reads litecoin.conf from the node data dir the desktop config names.
  writeFileSync(join(nodeConfDir, "litecoin.conf"), `rpcuser=${RPC_USER}\nrpcpassword=${RPC_PASS}\nrpcport=${RPC_PORT}\n`);
  const cfgPath = join(datadir, "desktop-config.json");
  writeFileSync(cfgPath, JSON.stringify({
    network: "BTCREGTEST", node_url: `http://127.0.0.1:${RPC_PORT}`, rpc_user: RPC_USER, rpc_password: RPC_PASS,
    data_dir: join(datadir, "desktop-data"), node_data_dir: nodeConfDir,
  }));

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
  const bodyText = () => ev(`document.body.innerText`);
  const clickText = (t) => ev(`(() => { const b = [...document.querySelectorAll("button")].find(b => b.innerText.trim() === ${JSON.stringify(t)}); if (!b) return false; b.click(); return true; })()`);

  check("original UI shows Select Network", await waitFor(`document.body.innerText.includes("Select Network")`), "");
  check("no 'no connection' banner (socket.io served)", await waitFor(`!document.body.innerText.includes("No connection with local server")`, 10000));
  await shot("legacy-01-network.png");
  check("click Select Network", await clickText("Select Network"));
  await sleep(1500);
  await shot("legacy-02-after-network.png");
  const afterNet = (await bodyText()).replace(/\s+/g, " ").slice(0, 300);
  console.log("after network:", afterNet);

  // Start the node connection the way the sync-node dialog does.
  const started = await ev(`(async () => {
    const b = [...document.querySelectorAll("button")].find(b => /start/i.test(b.innerText));
    if (!b) return "no start button";
    b.click(); return "clicked " + b.innerText.trim();
  })()`);
  console.log("start:", started);
  check("node start reached", started.startsWith("clicked"), started);
  await sleep(2000);
  console.log("toasts:", await ev(`[...document.querySelectorAll(".toast-message, .toast-title, .ngx-toastr")].map(e => e.innerText).join(" | ")`));
  console.log("direct start-wallet-node:", await ev(`fetch("http://tlapi.localhost/api/start-wallet-node", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({path: "", network: "LTCTEST", flags: {reindex: false, startclean: false}})}).then(async r => r.status + " " + JSON.stringify(await r.json()))`));
  const rpcOk = await waitFor(`fetch("http://tlapi.localhost/api/rpc-call", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({method: "getblockchaininfo", params: []})}).then(r => r.json()).then(j => j.data && j.data.chain === "regtest")`, 20000);
  check("page rpc-call getblockchaininfo reaches the regtest node", rpcOk);
  const denied = await ev(`fetch("http://tlapi.localhost/api/rpc-call", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({method: "dumpprivkey", params: ["x"]})}).then(async r => r.status + " " + JSON.stringify(await r.json()))`);
  check("page rpc-call dumpprivkey answers a node-wallet handle, not a key", /^200 .*"tln1:x"/.test(denied), denied);
  const mn = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const keys = await ev(`fetch("http://tlapi.localhost/keys/get-address", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({network: "LTCTEST", mnemonic: ${JSON.stringify(mn)}, derivatePath: "m/49/60/1/0/0"})}).then(async r => r.status + " " + JSON.stringify(await r.json()))`);
  check("key route answers a handle and an empty privkey (no key reaches the page)", /"privkey":""/.test(keys) && /"wif":"tlk1:[0-9a-f]{32}"/.test(keys) && !keys.includes("cNff91"), keys);
  const foreign = await ev(`fetch("https://example.com").then(() => "allowed", () => "blocked")`);
  check("CSP blocks arbitrary outbound hosts", foreign === "blocked", foreign);

  // new-block over the Rust socket.io server: mine and watch the UI's block counter text change.
  const before = await bodyText();
  cli("generatetoaddress", "3", minerAddr);
  const changed = await waitFor(`document.body.innerText !== ${JSON.stringify(before)}`, 20000);
  await shot("legacy-03-connected.png");
  console.log("after blocks:", (await bodyText()).replace(/\s+/g, " ").slice(0, 400));
  check("UI updated after new blocks", changed);
  check("no uncaught page exceptions", errors.length === 0, errors.slice(0, 3).join(" | ").slice(0, 600));
  ws.close();
} catch (e) {
  check("run completed without exception", false, e.stack || String(e));
} finally {
  if (app) killTree(app);
  try { cli("stop"); } catch (_) {}
  for (let i = 0; i < 40 && node.exitCode === null; i++) await sleep(250);
  try { rmSync(datadir, { recursive: true, force: true }); } catch (_) {}
  console.log(failures === 0 ? "E2E_LEGACY_OK" : `E2E_LEGACY_FAIL ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
