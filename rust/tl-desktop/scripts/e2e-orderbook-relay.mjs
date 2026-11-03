// Orderbook relay run: the Rust socket.io server in tl-desktop relays to a real legacy
// tl-orderbook-server, exercised from the page origin over the same `tlapi` scheme the Angular
// SocketService uses. Windows: WebView2.
// Usage: node e2e-orderbook-relay.mjs <tl-desktop.exe> <orderbook url, e.g. http://127.0.0.1:18190>
// The orderbook URL must be listed in the desktop config's `orderbook_urls` (this script writes
// that config). The orderbook server is started by the caller.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [exe, obUrl] = process.argv.slice(2);
const CDP_PORT = 9343;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); if (!ok) failures++; };
const killTree = (p) => { try { execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch (_) {} };

const dir = mkdtempSync(join(tmpdir(), "tl-desktop-ob-e2e-"));
const cfgPath = join(dir, "desktop-config.json");
writeFileSync(cfgPath, JSON.stringify({
  network: "BTCREGTEST", node_url: "http://127.0.0.1:1", rpc_user: "u", rpc_password: "p",
  data_dir: join(dir, "data"), node_data_dir: dir, orderbook_urls: [obUrl],
}));
const app = spawn(exe, [], { env: { ...process.env, TL_DESKTOP_CONFIG: cfgPath, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` }, stdio: "ignore" });

try {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === "page"); } catch (_) {}
    if (!page) await sleep(250);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  for (let i = 0; i < 60; i++) { try { if (await ev(`document.body.innerText.includes("Select Network")`)) break; } catch (_) {} await sleep(250); }
  check("original UI loaded", await ev(`document.body.innerText.includes("Select Network")`));

  // A minimal Engine.IO v4 polling client in the page: same origin, same scheme as the UI's socket.
  await ev(`(() => {
    const base = "http://tlapi.localhost/socket.io/?EIO=4&transport=polling";
    const SEP = String.fromCharCode(30);
    const t = window.__tlE2E = { sid: null, events: [] };
    t.open = async () => {
      const r = await (await fetch(base)).text();
      t.sid = JSON.parse(r.slice(1)).sid;
      await t.post("40");
      return t.sid;
    };
    t.post = (body) => fetch(base + "&sid=" + t.sid, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body }).then(r => r.status);
    t.emit = (name, arg) => t.post("42" + JSON.stringify(arg === undefined ? [name] : [name, arg]));
    t.pollOnce = async () => {
      const r = await (await fetch(base + "&sid=" + t.sid)).text();
      for (const p of r.split(SEP)) {
        if (p === "2") { await t.post("3"); continue; }
        if (p.startsWith("42")) { try { t.events.push(JSON.parse(p.slice(2))); } catch (_) {} }
      }
    };
    // The legacy server can emit an event more than once per request (placed-orders is sent from
    // both orderbook.class.ts and the socket handler), so tests wait for a matching payload.
    t.waitForMatch = async (name, pred, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const i = t.events.findIndex(e => e[0] === name && pred(e[1]));
        if (i >= 0) return t.events.splice(i, 1)[0];
        await t.pollOnce();
      }
      return null;
    };
    t.waitFor = async (name, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const i = t.events.findIndex(e => e[0] === name);
        if (i >= 0) return t.events.splice(i, 1)[0];
        await t.pollOnce();
      }
      return null;
    };
    return true;
  })()`);
  const sid = await ev(`window.__tlE2E.open()`);
  check("socket.io session opened on tlapi", typeof sid === "string" && sid.length > 0, sid);

  // A URL that is not in orderbook_urls is refused without contacting it.
  await ev(`window.__tlE2E.emit("ob-sockets-connect", "http://203.0.113.9:9190")`);
  const refused = await ev(`window.__tlE2E.waitFor("OB_SOCKET::connect_error", 8000)`);
  check("non-allowlisted orderbook URL refused", Array.isArray(refused), JSON.stringify(refused));

  await ev(`window.__tlE2E.emit("ob-sockets-connect", ${JSON.stringify(obUrl)})`);
  const connected = await ev(`window.__tlE2E.waitFor("OB_SOCKET::connect", 15000)`);
  check("OB_SOCKET::connect from the real orderbook server", Array.isArray(connected), JSON.stringify(connected));

  const filter = { type: "SPOT", first_token: 4, second_token: 5 };
  await ev(`window.__tlE2E.emit("update-orderbook", ${JSON.stringify(filter)})`);
  const data = await ev(`window.__tlE2E.waitFor("OB_SOCKET::orderbook-data", 15000)`);
  check("update-orderbook -> OB_SOCKET::orderbook-data", Array.isArray(data) && data[1] && Array.isArray(data[1].orders), JSON.stringify(data).slice(0, 200));

  const order = {
    keypair: { address: "tltc1qe2etestaddressxxxxxxxxxxxxxxxxxxxxxxx", pubkey: "02" + "11".repeat(32) },
    action: "BUY", type: "SPOT", isLimitOrder: true, marketName: "LTC/ALL",
    props: { id_desired: 4, id_for_sale: 5, amount: 1, price: 0.5 },
  };
  await ev(`window.__tlE2E.emit("new-order", ${JSON.stringify(order)})`);
  const saved = await ev(`window.__tlE2E.waitFor("OB_SOCKET::order:saved", 15000)`);
  const errEv = await ev(`window.__tlE2E.events.find(e => e[0] === "OB_SOCKET::order:error") || null`);
  check("new-order -> OB_SOCKET::order:saved", Array.isArray(saved) && typeof saved[1] === "string", JSON.stringify(saved || errEv));
  const uuid = JSON.stringify(saved?.[1] || "");
  const placed = await ev(`window.__tlE2E.waitForMatch("OB_SOCKET::placed-orders", d => (d.openedOrders || []).some(o => o.uuid === ${uuid}), 15000)`);
  const opened = placed?.[1]?.openedOrders || [];
  check("OB_SOCKET::placed-orders lists the order", opened.some((o) => o.uuid === saved?.[1]), `${opened.length} open; ${JSON.stringify(placed).slice(0, 300)}`);

  await ev(`window.__tlE2E.emit("update-orderbook", ${JSON.stringify(filter)})`);
  const data2 = await ev(`window.__tlE2E.waitFor("OB_SOCKET::orderbook-data", 15000)`);
  check("orderbook now holds the order", (data2?.[1]?.orders || []).some((o) => o.uuid === saved?.[1]), JSON.stringify(data2).slice(0, 160));

  await ev(`window.__tlE2E.emit("close-order", ${JSON.stringify(saved?.[1] || "")})`);
  const placed2 = await ev(`window.__tlE2E.waitForMatch("OB_SOCKET::placed-orders", d => !(d.openedOrders || []).some(o => o.uuid === ${uuid}), 15000)`);
  check("close-order removes it", Array.isArray(placed2) && !(placed2[1]?.openedOrders || []).some((o) => o.uuid === saved?.[1]));

  // Events outside the legacy allowlist are not forwarded (no reply expected, no crash).
  await ev(`window.__tlE2E.emit("not-a-relayed-event", {"x": 1})`);

  await ev(`window.__tlE2E.emit("ob-sockets-disconnect")`);
  const disc = await ev(`window.__tlE2E.waitFor("OB_SOCKET::disconnect", 15000)`);
  check("ob-sockets-disconnect -> OB_SOCKET::disconnect", Array.isArray(disc));
  ws.close();
} catch (e) {
  check("run completed without exception", false, e.stack || String(e));
} finally {
  killTree(app);
  try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(failures === 0 ? "E2E_RELAY_OK" : `E2E_RELAY_FAIL ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
