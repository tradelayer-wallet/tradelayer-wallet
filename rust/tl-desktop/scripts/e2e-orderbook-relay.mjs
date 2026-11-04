// Orderbook relay run: the Rust socket.io server in tl-desktop relays to a real tl-orderbook-server
// (HyperExpress/uWebSockets, raw WebSocket, branch `auth`), exercised from the page origin over the
// same `tlapi` socket.io endpoint the Angular SocketService uses. Windows: WebView2.
//
// Usage: node e2e-orderbook-relay.mjs <tl-desktop.exe> <orderbook origin, e.g. ws://127.0.0.1:3001>
//
// The origin must be listed in the desktop config's `orderbook_urls` (this script writes that config).
// The orderbook server is started by the caller. The relay is a `web` class client (the server reads
// no class header), so it reads and the server refuses its mutations; a second, direct WebSocket
// client sends `x-tradelayer-client: desktop`, which the benchmark export of the server honours
// (scratch export with the upgrade passthrough, port 3001), and places the orders the relay must see.
// Against a server that gives that header no meaning the direct client's order is refused; the run
// then fails at "direct client placed an order" and says why.
//
// The legacy (socket.io) orderbook server is no longer spoken to: this relay is the WebSocket
// relay of FE-speed's ob-sockets.service.ts. The master UI's own endpoints (9190/8190) are legacy
// socket.io servers and need the pre-WebSocket relay (git history before this change).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [exe, obOrigin] = process.argv.slice(2);
const CDP_PORT = Number(process.env.CDP_PORT || 9343);
const NET = "LTCTEST";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); if (!ok) failures++; };
const killTree = (p) => { try { execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch (_) {} };

// A market of its own per run: quote id 2000..2999 against property 4 (spot key "4-<q>").
const Q = 2000 + Math.floor(Math.random() * 1000);
const MK = `4-${Q}`;
const SELL_PRICE = 2000 + Math.floor(Math.random() * 500);

// ---- the direct client (desktop class through the upgrade header)
function directClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { "x-tradelayer-client": "desktop" } });
    const c = { ws, events: [], hello: null };
    ws.onmessage = (m) => { try { const j = JSON.parse(String(m.data)); c.events.push(j); if (j.event === "connected") c.hello = j; } catch (_) {} };
    ws.onopen = () => resolve(c);
    ws.onerror = (e) => reject(new Error("direct client: " + (e.message || "error")));
    c.send = (o) => ws.send(JSON.stringify(o));
    c.wait = async (pred, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const i = c.events.findIndex(pred); if (i >= 0) return c.events.splice(i, 1)[0]; await sleep(25); }
      return null;
    };
  });
}

const dir = mkdtempSync(join(tmpdir(), "tl-desktop-ob-e2e-"));
const cfgPath = join(dir, "desktop-config.json");
writeFileSync(cfgPath, JSON.stringify({
  network: "BTCREGTEST", node_url: "http://127.0.0.1:1", rpc_user: "u", rpc_password: "p",
  data_dir: join(dir, "data"), node_data_dir: dir, orderbook_urls: [obOrigin],
}));
const app = spawn(exe, [], { env: { ...process.env, TL_DESKTOP_CONFIG: cfgPath, WEBVIEW2_USER_DATA_FOLDER: join(dir, "webview2"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` }, stdio: "ignore" });
let direct = null;

try {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === "page"); } catch (_) {}
    if (!page) await sleep(250);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  for (let i = 0; i < 60; i++) { try { if (await ev(`location.href.startsWith("http://tauri.localhost") && document.readyState === "complete"`)) break; } catch (_) {} await sleep(250); }

  // The UI in the page keeps a socket.io session of its own (XHR polling) and, since it reconnects by
  // itself, would take the single current session back from this test. Its XHRs to the socket.io
  // endpoint are failed; this test's own client uses fetch().
  await ev(`(() => {
    const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__tlBlocked = String(u).startsWith("http://tlapi.localhost/socket.io/"); return open.call(this, m, u, ...r); };
    XMLHttpRequest.prototype.send = function (...a) {
      if (this.__tlBlocked) { setTimeout(() => this.dispatchEvent(new Event("error")), 20); return; }
      return send.apply(this, a);
    };
    return true;
  })()`);
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
    t.waitForMatch = async (name, pred, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const i = t.events.findIndex(e => e[0] === name && pred(e[1]));
        if (i >= 0) return t.events.splice(i, 1)[0];
        await t.pollOnce();
      }
      return null;
    };
    t.waitFor = (name, ms) => t.waitForMatch(name, () => true, ms);
    return true;
  })()`);
  const sid = await ev(`window.__tlE2E.open()`);
  check("socket.io session opened on tlapi", typeof sid === "string" && sid.length > 0, sid);

  // A URL that is not in orderbook_urls is refused without contacting it.
  await ev(`window.__tlE2E.emit("ob-sockets-connect", "ws://203.0.113.9:3001/ws")`);
  const refused = await ev(`window.__tlE2E.waitFor("OB_SOCKET::connect_error", 8000)`);
  check("non-allowlisted orderbook URL refused", Array.isArray(refused), JSON.stringify(refused));
  await ev(`window.__tlE2E.emit("ob-sockets-connect", ${JSON.stringify(obOrigin + "/admin")})`);
  const refused2 = await ev(`window.__tlE2E.waitFor("OB_SOCKET::connect_error", 8000)`);
  check("path other than / or /ws refused", Array.isArray(refused2), JSON.stringify(refused2));

  const wsUrl = obOrigin.replace(/\/+$/, "") + "/ws";
  await ev(`window.__tlE2E.emit("ob-sockets-connect", ${JSON.stringify(wsUrl)})`);
  const connected = await ev(`window.__tlE2E.waitFor("OB_SOCKET::connect", 15000)`);
  check("OB_SOCKET::connect with an empty object payload", Array.isArray(connected) && JSON.stringify(connected[1]) === "{}", JSON.stringify(connected));
  const hello = await ev(`window.__tlE2E.waitFor("OB_SOCKET::connected", 15000)`);
  const h = hello?.[1] || {};
  check("OB_SOCKET::connected carries the server hello", h.event === "connected" && typeof h.id === "string" && h.clientClass === "web" && h.authRequired === true, JSON.stringify(hello));

  await ev(`window.__tlE2E.emit("update-orderbook", ${JSON.stringify({ type: "SPOT", first_token: 4, second_token: Q, network: NET })})`);
  const data = await ev(`window.__tlE2E.waitFor("OB_SOCKET::orderbook-data", 15000)`);
  check("update-orderbook -> OB_SOCKET::orderbook-data (whole message, flat)", Array.isArray(data) && data[1]?.event === "orderbook-data" && data[1]?.orders && typeof data[1].orders === "object", JSON.stringify(data).slice(0, 220));

  await ev(`window.__tlE2E.emit("orderbook:join", ${JSON.stringify({ marketKey: MK, network: NET })})`);
  const joined = await ev(`window.__tlE2E.waitFor("OB_SOCKET::orderbook-data", 15000)`);
  check("orderbook:join -> a snapshot", Array.isArray(joined), JSON.stringify(joined).slice(0, 160));

  // The relay is a web client: its own mutation is refused with the server's reason.
  const order = (uuid, price) => ({
    isLimitOrder: true, type: "SPOT", network: NET, uuid, marketKey: MK, price, amount: 1,
    props: { id_for_sale: Q, id_desired: 4, price, amount: 1 },
  });
  await ev(`window.__tlE2E.emit("new-order", ${JSON.stringify(order("relay-order-1", SELL_PRICE))})`);
  const refusedOrder = await ev(`window.__tlE2E.waitFor("OB_SOCKET::order:error", 8000)`);
  check("the web-class relay's new-order is refused by the server", Array.isArray(refusedOrder) && /Authentication required/.test(refusedOrder[1]?.message || ""), JSON.stringify(refusedOrder));
  await ev(`window.__tlE2E.emit("close-order", ${JSON.stringify({ orderUUID: "relay-order-1", marketKey: MK, network: NET })})`);
  const refusedClose = await ev(`window.__tlE2E.waitFor("OB_SOCKET::order:error", 8000)`);
  check("the web-class relay's close-order is refused by the server", Array.isArray(refusedClose) && /Authentication required/.test(refusedClose[1]?.message || ""), JSON.stringify(refusedClose));

  // A direct client (desktop class) places an order; the relay session sees it in the book.
  direct = await directClient(wsUrl);
  await direct.wait((e) => e.event === "connected", 5000);
  check("direct client is class desktop", direct.hello?.clientClass === "desktop", JSON.stringify(direct.hello));
  direct.send({ event: "orderbook:join", marketKey: MK, network: NET });
  const dUuid = `direct-${Date.now()}`;
  direct.send({ event: "new-order", ...order(dUuid, SELL_PRICE) });
  const savedEv = await direct.wait((e) => e.event === "order:saved" || e.event === "order:error", 8000);
  check("direct client placed an order", savedEv?.event === "order:saved", JSON.stringify(savedEv));
  const sees = await ev(`window.__tlE2E.waitForMatch("OB_SOCKET::orderbook-data", d => JSON.stringify(d.orders || {}).includes(${JSON.stringify(String(SELL_PRICE))}), 15000)`);
  check("the relay session's book shows the order", Array.isArray(sees), JSON.stringify(sees).slice(0, 300));

  // Cancel it from the direct client. The server answers a cancel to the canceller only (no market
  // broadcast), so the relay session asks for a fresh snapshot, which no longer holds the order.
  direct.send({ event: "close-order", orderUUID: dUuid, marketKey: MK, network: NET });
  await direct.wait((e) => e.event === "placed-orders", 8000);
  await ev(`window.__tlE2E.emit("update-orderbook", ${JSON.stringify({ type: "SPOT", first_token: 4, second_token: Q, network: NET })})`);
  const gone = await ev(`window.__tlE2E.waitForMatch("OB_SOCKET::orderbook-data", d => d.marketKey === ${JSON.stringify(MK)} && !JSON.stringify(d.orders || {}).includes(${JSON.stringify(String(SELL_PRICE))}), 15000)`);
  check("a fresh snapshot no longer holds the cancelled order", Array.isArray(gone), JSON.stringify(gone).slice(0, 200));

  // Events outside the allowlist are not forwarded (no reply expected, no crash).
  await ev(`window.__tlE2E.emit("not-a-relayed-event", {"x": 1})`);
  await ev(`window.__tlE2E.emit("disconnect")`);

  await ev(`window.__tlE2E.emit("ob-sockets-disconnect")`);
  const disc = await ev(`window.__tlE2E.waitFor("OB_SOCKET::disconnect", 15000)`);
  check("ob-sockets-disconnect -> OB_SOCKET::disconnect", Array.isArray(disc));
  ws.close();
} catch (e) {
  check("run completed without exception", false, e.stack || String(e));
} finally {
  try { direct?.ws.close(); } catch (_) {}
  killTree(app);
  try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(failures === 0 ? "E2E_RELAY_OK" : `E2E_RELAY_FAIL ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
