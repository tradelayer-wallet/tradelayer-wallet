// Regtest end-to-end run of the tl-desktop app (Windows: WebView2 + Bitcoin Core 31.1), driven through its real UI over the
// WebView2 DevTools protocol. Usage: node e2e.mjs <tl-desktop.exe> <out dir>
// Starts a throwaway bitcoind -regtest, never touches any other node or datadir.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [exe, outDir] = process.argv.slice(2);
const BIN = join(process.env.LOCALAPPDATA, "Programs/BitcoinCore/bitcoin-31.1/bin");
const RPC_PORT = 18998, CDP_PORT = 9334;
const PASSWORD = "e2e synthetic password 1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let failures = 0;
function check(name, ok, detail = "") {
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!ok) failures++;
}

mkdirSync(outDir, { recursive: true });
const datadir = mkdtempSync(join(tmpdir(), "tl-desktop-e2e-"));
const cliArgs = [`-datadir=${datadir}`, "-regtest", `-rpcport=${RPC_PORT}`];
const cli = (...a) => execFileSync(join(BIN, "bitcoin-cli.exe"), [...cliArgs, ...a], { encoding: "utf8" }).trim();
const cliw = (...a) => cli("-rpcwallet=funder", ...a);

const node = spawn(join(BIN, "bitcoind.exe"), [
  `-datadir=${datadir}`, "-regtest", "-listen=0", `-rpcport=${RPC_PORT}`,
  "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1", "-fallbackfee=0.0001", "-txindex=0",
], { stdio: "ignore" });
let app = null;
const killTree = (p) => { try { execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch (_) {} };

async function cleanup() {
  if (app) killTree(app);
  try { cli("stop"); } catch (_) {}
  for (let i = 0; i < 40 && node.exitCode === null; i++) await sleep(250);
  try { rmSync(datadir, { recursive: true, force: true }); } catch (_) {}
}

try {
  for (let i = 0; ; i++) {
    try { execFileSync(join(BIN, "bitcoin-cli.exe"), [...cliArgs, "getblockchaininfo"], { stdio: "ignore" }); break; } catch (e) { if (i > 80) throw e; await sleep(250); }
  }
  cli("createwallet", "funder");
  const funderAddr = cliw("getnewaddress");
  cliw("generatetoaddress", "101", funderAddr);
  log("node ready, height", cli("getblockcount"));

  const cookie = join(datadir, "regtest", ".cookie");
  const cfgPath = join(datadir, "desktop-config.json");
  writeFileSync(cfgPath, JSON.stringify({
    network: "BTCREGTEST",
    node_url: `http://127.0.0.1:${RPC_PORT}`,
    rpc_cookie_file: cookie,
    data_dir: join(datadir, "desktop-data"),
  }));

  async function launch() {
    const a = spawn(exe, [], {
      env: { ...process.env, TL_DESKTOP_CONFIG: cfgPath, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
      stdio: "ignore",
    });
    let page;
    for (let i = 0; i < 80 && !page; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === "page"); } catch (_) {}
      if (!page) await sleep(250);
    }
    if (!page) throw new Error("no webview page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pending = new Map();
    ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
      return r.result?.result?.value;
    };
    const shot = async (name) => {
      const s = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(outDir, name), Buffer.from(s.result.data, "base64"));
    };
    return { proc: a, ev, shot, close: () => ws.close() };
  }

  const ui = await launch();
  app = ui.proc;
  const { ev, shot } = ui;
  const waitFor = async (expr, ms = 15000) => {
    for (let t = 0; t < ms; t += 200) { try { if (await ev(expr)) return true; } catch (_) {} await sleep(200); }
    return false;
  };
  const visible = (id) => `!document.getElementById(${JSON.stringify(id)}).hidden`;
  const text = (id) => ev(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const setVal = (id, v) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; return true; })()`);
  const click = (id) => ev(`(document.getElementById(${JSON.stringify(id)}).click(), true)`);
  const errorText = () => ev(`(() => { const e = document.getElementById("error"); return e.hidden ? "" : e.textContent; })()`);

  check("setup view shown for a fresh data dir", await waitFor(visible("view-setup")));
  check("node chip shows regtest", (await text("chip-node")) === "node regtest", await text("chip-node"));
  check("network chip shows BTCREGTEST", (await text("chip-network")) === "BTCREGTEST");
  await shot("01-setup.png");

  await setVal("create-pass", PASSWORD); await setVal("create-pass2", PASSWORD);
  await click("btn-create");
  check("backup phrase shown", await waitFor(visible("view-backup"), 60000));
  const words = await ev(`[...document.querySelectorAll("#backup-words li")].map(l => l.textContent)`);
  check("backup phrase has 12 words", words.length === 12, String(words.length));
  await click("btn-backup-done");
  check("wallet view after backup", await waitFor(visible("view-wallet")));
  check("backup words cleared from DOM", (await ev(`document.querySelectorAll("#backup-words li").length`)) === 0);
  await waitFor(`document.getElementById("receive-address").textContent.startsWith("bcrt1q")`);
  const recv = await text("receive-address");
  check("receive address is bcrt1q", recv.startsWith("bcrt1q"), recv);
  const va = JSON.parse(cli("validateaddress", recv));
  check("node validates receive address", va.isvalid === true);

  const fundTxid = cliw("sendtoaddress", recv, "1.5");
  cliw("generatetoaddress", "1", funderAddr);
  await click("btn-refresh");
  check("balance shows 1.5 after funding", await waitFor(`document.getElementById("bal-confirmed").textContent === "1.50000000"`), await text("bal-confirmed"));
  check("one utxo", (await text("bal-utxos")) === "1");
  await shot("02-funded.png");

  const dest = cliw("getnewaddress");
  await setVal("send-to", dest); await setVal("send-amount", "0.4"); await setVal("send-fee", "3");
  await click("btn-prepare");
  check("preview shown", await waitFor(visible("preview")), await errorText());
  const pv = {
    to: await text("pv-to"), amount: await text("pv-amount"), fee: await text("pv-fee"),
    change: await text("pv-change"), rate: await text("pv-rate"), inputs: await text("pv-inputs"),
  };
  log("preview", JSON.stringify(pv));
  check("preview recipient and amount", pv.to === dest && pv.amount === "0.40000000");
  const toSats = (s) => { const [w, f] = s.split("."); return BigInt(w) * 100000000n + BigInt(f); };
  check("preview conserves value", toSats(pv.amount) + toSats(pv.fee) + toSats(pv.change) === 150000000n);
  await shot("03-preview.png");

  await click("btn-confirm");
  check("broadcast txid shown", await waitFor(visible("sent"), 30000), await errorText());
  const txid = await text("sent-txid");
  log("txid", txid);
  const mem = JSON.parse(cli("getrawmempool"));
  check("tx in node mempool", mem.includes(txid));
  const tx = JSON.parse(cli("decoderawtransaction", cli("getrawtransaction", txid)));
  const outs = tx.vout.map((o) => ({ v: Math.round(o.value * 1e8), a: o.scriptPubKey.address }));
  check("tx pays 0.4 to destination", outs.some((o) => o.a === dest && o.v === 40000000), JSON.stringify(outs));
  check("tx spends the funding output", tx.vin.length === 1 && tx.vin[0].txid === fundTxid);
  const entry = JSON.parse(cli("getmempoolentry", txid));
  const feeSats = Math.round(entry.fees.base * 1e8);
  check("node fee equals preview fee", BigInt(feeSats) === toSats(pv.fee), `${feeSats}`);
  check("fee rate at least 3 sat/vB", feeSats / entry.vsize >= 3, `${feeSats}/${entry.vsize}`);
  await shot("04-sent.png");

  cliw("generatetoaddress", "1", funderAddr);
  await click("btn-refresh");
  const expected = 150000000n - 40000000n - toSats(pv.fee);
  const expectedText = `${expected / 100000000n}.${(expected % 100000000n).toString().padStart(8, "0")}`;
  check("balance after send is change", await waitFor(`document.getElementById("bal-confirmed").textContent === ${JSON.stringify(expectedText)}`), await text("bal-confirmed"));

  // Negative paths through the same IPC the page uses.
  const unknownPlan = await ev(`window.__TAURI__.core.invoke("confirm_send", {planId: "00000000000000000000000000000000"}).then(() => "accepted", e => String(e))`);
  check("unknown plan id refused", unknownPlan.includes("UnknownPlan"), unknownPlan);
  const replay = await ev(`window.__TAURI__.core.invoke("confirm_send", {planId: ${JSON.stringify("x")}}).then(() => "accepted", e => String(e))`);
  check("garbage plan id refused", replay !== "accepted", replay);
  const plugin = await ev(`window.__TAURI__.core.invoke("plugin:event|emit", {event: "x", payload: 1}).then(() => "allowed", e => String(e))`);
  check("core plugin commands are not granted", plugin !== "allowed", plugin);
  // DevTools evaluation is exempt from CSP, so probe with page-inserted script and fetch.
  const inline = await ev(`new Promise(r => { const s = document.createElement("script"); s.textContent = "window.__inl = 1"; document.body.appendChild(s); setTimeout(() => r(window.__inl === 1 ? "ran" : "blocked"), 200); })`);
  check("CSP blocks inline script", inline === "blocked", inline);
  const net = await ev(`fetch("https://example.com").then(() => "allowed", () => "blocked")`);
  check("CSP blocks outbound network", net === "blocked", net);

  // Lock, wrong password, right password.
  await click("btn-lock");
  check("unlock view after lock", await waitFor(visible("view-unlock")));
  const lockedAddr = await ev(`window.__TAURI__.core.invoke("receive_address").then(() => "leaked", e => String(e))`);
  check("receive_address refused while locked", lockedAddr.includes("Locked"), lockedAddr);
  await setVal("unlock-pass", "wrong password"); await click("btn-unlock");
  check("wrong password error", await waitFor(`!document.getElementById("error").hidden`, 60000), await errorText());
  check("still locked after wrong password", await ev(visible("view-unlock")));
  await setVal("unlock-pass", PASSWORD); await click("btn-unlock");
  check("unlock with right password", await waitFor(visible("view-wallet"), 60000), await errorText());
  check("same receive address after unlock", (await waitFor(`document.getElementById("receive-address").textContent === ${JSON.stringify(recv)}`)));
  await shot("05-unlocked.png");
  ui.close();
  killTree(app); app = null;
  await sleep(1500);

  // Restart: the vault persists and opens locked.
  const ui2 = await launch();
  app = ui2.proc;
  check("restart opens locked", await (async () => { for (let t = 0; t < 15000; t += 200) { try { if (await ui2.ev(`!document.getElementById("view-unlock").hidden`)) return true; } catch (_) {} await sleep(200); } return false; })());
  ui2.close();
} catch (e) {
  check("run completed without exception", false, e.stack || String(e));
} finally {
  await cleanup();
  log(failures === 0 ? "E2E_OK" : `E2E_FAIL ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
