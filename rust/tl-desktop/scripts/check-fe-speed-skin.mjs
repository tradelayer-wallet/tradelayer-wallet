// Screenshot + live-chart check for the FE-speed UI inside the Tauri window (Windows, WebView2).
//
// Usage: node scripts/check-fe-speed-skin.mjs <tl-desktop.exe> <out dir> <prefix> [--ob ws://127.0.0.1:3001] [--chart]
//
// Starts a throwaway bitcoind -regtest, launches the exe with WebView2 remote debugging, drives
// Select Network / Start Node, connects the orderbook through the Servers window and walks the
// screens, saving <out dir>/<prefix>-<screen>.png. The orderbook must be a running
// tl-orderbook-server (markets at /markets/{spot,futures}/<network>); the exe's CSP has to allow its
// http origin. --mock-ob serves the same market lists and a WebSocket hello on the --ob port instead
// (for when no orderbook server is running). With --chart it opens Futures Trading and Spot Trading and requires, per market, that
// BitcornWisdom's SDK `candle` event arrives (within 60 s) and reports the venue that served it; it
// also switches market (BTC/USDT, LTC/USDT, TL/USDT, TL/LTC) and checks the chart follows, and
// that no CSP violation or uncaught exception was logged. Prints CHECK_SKIN_OK or CHECK_SKIN_FAIL.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const bare = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const obOrigin = flag("--ob") || "ws://127.0.0.1:3001";
const withChart = bare("--chart");
const mockOb = bare("--mock-ob");
const [exe, outArg, prefix] = argv;
if (!exe || !outArg || !prefix) {
  console.error("usage: check-fe-speed-skin.mjs <tl-desktop.exe> <out dir> <prefix> [--ob ws://host:port] [--chart]");
  process.exit(2);
}
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const BIN = join(process.env.LOCALAPPDATA, "Programs/BitcoinCore/bitcoin-31.1/bin");
const RPC_PORT = Number(process.env.RPC_PORT || 18911), CDP_PORT = Number(process.env.CDP_PORT || 9361);
const RPC_USER = "skinuser", RPC_PASS = "skin-synthetic-rpc-password";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const check = (name, ok, detail = "") => { log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); if (!ok) failures.push(name); return ok; };
const killTree = (pid) => { try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch (_) {} };

// A stand-in orderbook: the market lists of tl-orderbook-server (src/services/markets/manager.class.ts,
// LTCTEST) over HTTP, and a WebSocket endpoint that sends the hello and ignores everything else.
function startMockOrderbook(port) {
  const tok = (shortName, fullName, propertyId) => ({ shortName, fullName, propertyId });
  const spotPair = (a, b) => ({ first_token: a, second_token: b, disabled: false, pairString: `${a.shortName}/${b.shortName}` });
  const contract = (a, b, id, name, collateral) => ({ first_token: a, second_token: b, contract_id: id, contractName: name, collateral, disabled: false, pairString: `${a.shortName}/${b.shortName}` });
  const LTC = tok("LTC", "LTC", 0), USDTt = tok("USDTt", "USDTt", 5), TLTC = tok("TLTC", "TLTC", 0), TLt = tok("TLt", "TLt", 1), sLTCt = tok("sLTCt", "sLTCt", "s1-5");
  const spot = [{ name: "TLTC", icon: "https://example.invalid/ltc.png", disabled: false,
    markets: [spotPair(TLTC, USDTt), spotPair(TLt, LTC), spotPair(sLTCt, LTC), spotPair(TLt, USDTt), spotPair(sLTCt, USDTt)] }];
  const fLTC = tok("LTC", "Litecoin", 0), fUSDT = tok("USDT", "Tether US", 5), fTL = tok("TL", "TradeLayer Native Metacoin", 1), fBTC = tok("BTC", "Bitcoin Oracle", 1);
  const futures = [
    { name: "USD", icon: "https://example.invalid/usd.png", disabled: false, markets: [
      contract(fBTC, fUSDT, 2, "BTC/USDT", fUSDT), contract(fLTC, fUSDT, 3, "LTC/USDT", fUSDT), contract(fTL, fUSDT, 4, "TL/USDT", fUSDT)] },
    { name: "LTC", icon: "https://example.invalid/ltc.png", disabled: false, markets: [contract(fTL, fLTC, 1, "TL/LTC", fTL)] },
  ];
  const server = createServer((req, res) => {
    const m = /^[/]markets[/](spot|futures)[/]/.exec(req.url || "");
    res.setHeader("access-control-allow-origin", "*");
    if (!m) { res.statusCode = 404; res.end("{}"); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: m[1] === "spot" ? spot : futures }));
  });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
    const hello = Buffer.from(JSON.stringify({ event: "connected", id: "Mock-1", clientClass: "web", authRequired: true }));
    socket.write(Buffer.concat([Buffer.from([0x81, hello.length]), hello]));
    socket.on("data", () => {}); // client frames (masked) are ignored
    socket.on("error", () => {});
  });
  return new Promise((res) => server.listen(port, "127.0.0.1", () => res(server)));
}
let mock = null;
if (mockOb) mock = await startMockOrderbook(Number(new URL(obOrigin.replace(/^ws/, "http")).port));

const datadir = mkdtempSync(join(tmpdir(), "tl-skin-"));
const nodeConfDir = join(datadir, "litecoin-datadir");
mkdirSync(nodeConfDir);
const cliArgs = [`-datadir=${datadir}`, "-regtest", `-rpcport=${RPC_PORT}`, `-rpcuser=${RPC_USER}`, `-rpcpassword=${RPC_PASS}`];
const cli = (...a) => execFileSync(join(BIN, "bitcoin-cli.exe"), [...cliArgs, ...a], { encoding: "utf8" }).trim();
const node = spawn(join(BIN, "bitcoind.exe"), [
  `-datadir=${datadir}`, "-regtest", "-listen=0", `-rpcport=${RPC_PORT}`, `-rpcuser=${RPC_USER}`, `-rpcpassword=${RPC_PASS}`,
  "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1",
], { stdio: "ignore" });
let app = null, ws = null, msgId = 0;
const pending = new Map();
const exceptions = [], consoleMessages = [], cspViolations = [], blocked = [];
const requests = new Map();

function cdp(method, params = {}, timeoutMs = 20000) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(`CDP ${method}: ${m.error.message}`)) : res(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expr, timeoutMs = 20000) {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
const waitFor = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 250) { try { if (await ev(expr)) return true; } catch (_) {} await sleep(250); } return false; };
async function shot(name) {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  const file = join(out, `${prefix}-${name}.png`);
  writeFileSync(file, Buffer.from(r.data, "base64"));
  log(`screenshot ${file}`);
}
// click the last element whose own text (trimmed) equals `text`
const clickText = (text, sel = "a,button,span,div,li") => ev(`(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.innerText && e.innerText.trim() === ${JSON.stringify(text)});
  const e = els[els.length - 1]; if (!e) return false; e.click(); return true; })()`);

try {
  for (let i = 0; ; i++) { try { cli("getblockchaininfo"); break; } catch (e) { if (i > 80) throw e; await sleep(250); } }
  cli("createwallet", "miner");
  const addr = cli("-rpcwallet=miner", "getnewaddress");
  cli("generatetoaddress", "3", addr);
  writeFileSync(join(nodeConfDir, "litecoin.conf"), `rpcuser=${RPC_USER}\nrpcpassword=${RPC_PASS}\nrpcport=${RPC_PORT}\n`);
  const cfg = join(datadir, "desktop-config.json");
  writeFileSync(cfg, JSON.stringify({
    network: "BTCREGTEST", node_url: `http://127.0.0.1:${RPC_PORT}`, rpc_user: RPC_USER, rpc_password: RPC_PASS,
    data_dir: join(datadir, "desktop-data"), node_data_dir: nodeConfDir, orderbook_urls: [obOrigin],
  }));
  app = spawn(exe, [], {
    env: { ...process.env, TL_DESKTOP_CONFIG: cfg, WEBVIEW2_USER_DATA_FOLDER: join(datadir, "webview2"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
    stdio: "ignore",
  });
  let page;
  for (let i = 0; i < 160 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === "page"); } catch (_) {}
    if (!page) await sleep(250);
  }
  if (!page) throw new Error("no WebView2 page target");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const text = (a) => String(a.value ?? a.description ?? a.type);
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    const p = msg.params || {};
    if (msg.method === "Runtime.exceptionThrown") exceptions.push((p.exceptionDetails.exception?.description || p.exceptionDetails.text).slice(0, 600));
    else if (msg.method === "Runtime.consoleAPICalled") consoleMessages.push({ type: p.type, text: p.args.map(text).join(" ").slice(0, 400) });
    else if (msg.method === "Log.entryAdded") {
      const t = `${p.entry.text} ${p.entry.url || ""}`.slice(0, 500);
      consoleMessages.push({ type: `log.${p.entry.level}`, text: t });
      if (/Content Security Policy|violates the following/i.test(t)) cspViolations.push(t);
    } else if (msg.method === "Network.loadingFailed" && p.blockedReason) blocked.push(`${p.blockedReason} ${requests.get(p.requestId) || ""}`);
    else if (msg.method === "Network.requestWillBeSent") requests.set(p.requestId, p.request.url);
  };
  await Promise.all([cdp("Runtime.enable"), cdp("Log.enable"), cdp("Page.enable"), cdp("Network.enable")]);
  // listen for CSP violations from every frame too (securitypolicyviolation fires on the document)
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI), true);` });
  await cdp("Page.reload", { ignoreCache: true });

  check("UI shows Select Network", await waitFor(`[...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Select Network")`, 40000));
  // SKIN_CSS=<compiled css file>: inject a stylesheet into the page (iterate on styles without a rebuild)
  if (process.env.SKIN_CSS) {
    const css = readFileSync(process.env.SKIN_CSS, "utf8");
    await ev(`(() => { const s = document.createElement("style"); s.id = "skin-inject"; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); return true; })()`);
  }
  await sleep(1200);
  await shot("00-select-network");
  await ev(`(() => { const b = [...document.querySelectorAll("button")].filter((x) => x.innerText.trim() === "Select Network"); b[b.length - 1].click(); return true; })()`);
  check("Start Node clicked", await waitFor(`(() => { const b = [...document.querySelectorAll("button")].find(b => /start node/i.test(b.innerText) && !b.disabled); if (!b) return false; b.click(); return true; })()`, 20000));
  check("menu shows Spot Trading", await waitFor(`document.body.innerText.includes("Spot Trading")`, 40000));
  check("node synced", await waitFor(`document.body.innerText.includes("SYNCED")`, 40000));
  await sleep(1500);
  await shot("01-home-sync-window");

  // Servers window: the custom entry of the orderbook list takes the ws URL. The window is hidden
  // at first (its bottom-bar tab toggles it); the inputs exist in the DOM regardless.
  await ev(`(() => { const input = [...document.querySelectorAll("input.input_url")][0]; if (!input) return false; input.closest(".server").click(); return true; })()`);
  await sleep(400);
  const wsUrl = `${obOrigin.replace(/[/]+$/, "")}/ws`;
  await ev(`(() => { const input = [...document.querySelectorAll("input.input_url")][0]; if (!input || input.disabled) return false; input.value = ${JSON.stringify(wsUrl)}; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await ev(`(() => { const b = [...document.querySelectorAll("button")].filter(b => b.innerText.trim() === "Connect")[0]; if (!b) return false; b.click(); return true; })()`);
  check("orderbook connected", await waitFor(`[...document.querySelectorAll("button")].some(b => b.innerText.trim() === "disconnect")`, 20000));
  await sleep(800);
  const tab = (t) => ev(`(() => { const e = [...document.querySelectorAll("*")].filter((x) => x.children.length === 0 && x.innerText && x.innerText.trim() === ${JSON.stringify(t)}); const el = e[e.length - 1]; if (el) el.click(); return !!el; })()`);
  await tab("Synchronization"); // hide the window that opened at start
  await sleep(500);
  await shot("02-home");
  await tab("Servers");
  await sleep(600);
  await shot("03-servers-window");
  await tab("Servers");
  await sleep(500);
  const route = async (label, name, settle = 4000) => {
    const ok = await ev(`(() => { const a = [...document.querySelectorAll("a[mat-tab-link]")].find((x) => x.innerText.trim() === ${JSON.stringify(label)}); if (!a) return false; a.click(); return true; })()`);
    if (!ok) { log(`route ${label} not in the header`); return false; }
    await sleep(settle);
    // the futures screen asks for the wallet password first; this check has no wallet password
    if (await ev(`document.body.innerText.includes("Password Required")`)) {
      await clickText("Cancel", "button");
      await sleep(600);
    }
    await shot(name);
    return true;
  };
  const routes = await ev(`[...document.querySelectorAll("a[mat-tab-link]")].map((x) => x.innerText.trim())`);
  log(`header routes: ${JSON.stringify(routes)}`);
  if (routes.includes("Home")) await route("Home", "05-home-page");
  if (routes.includes("Portfolio")) await route("Portfolio", "06-portfolio");

  if (withChart) {
    // instrument the SDK: capture events through the iframe's window messages (the SDK posts them to the page)
    await ev(`(() => { window.__bw = { candles: [], sources: [], status: [], errors: [], instruments: new Set() };
      window.addEventListener("message", (e) => { const m = e.data; if (!m || m.bitcorn !== "v1" || m.type !== "event") return;
        if (m.event === "candle") { window.__bw.candles.push({ t: Date.now(), instrument: m.payload.instrument, venue: m.payload.source && m.payload.source.venue, close: m.payload.candle.close }); window.__bw.instruments.add(m.payload.instrument); }
        else if (m.event === "source") window.__bw.sources.push({ t: Date.now(), venue: m.payload.source && m.payload.source.venue, reason: m.payload.reason, instrument: m.payload.source && m.payload.source.instrument });
        else if (m.event === "status") window.__bw.status.push(m.payload.state);
        else if (m.event === "error") window.__bw.errors.push(m.payload.message); }); return true; })()`);
    const chartState = () => ev(`(() => { const c = window.__bw; const last = c.candles[c.candles.length - 1];
      return { n: c.candles.length, last: last || null, sources: c.sources.slice(-4), status: c.status.slice(-3), errors: c.errors.slice(-3),
        frame: !!document.querySelector("tl-bitcorn-chart iframe"), note: (document.querySelector("tl-bitcorn-chart") || {}).innerText || null }; })()`);
    const waitCandle = async (instrument, ms = 60000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const s = await chartState();
        const hit = s.last && (!instrument || s.last.instrument === instrument) && s.last.t > t0 - 100;
        if (hit) return { ...s, ms: Date.now() - t0 };
        await sleep(500);
      }
      return { ...(await chartState()), ms: null };
    };
    const pickMarket = async (text) => ev(`(() => { const e = [...document.querySelectorAll("button,div,span,mat-tab,a,li")].filter((x) => x.children.length < 3 && x.innerText && x.innerText.trim() === ${JSON.stringify(text)}); const el = e[e.length - 1]; if (!el) return false; el.click(); return true; })()`);
    const results = [];
    const plan = [
      ["Futures Trading", "07-futures", [["BTC/USDT", "BTC-USDT-PERP", "futures-btc"], ["LTC/USDT", "LTC-USDT-PERP", "futures-ltc"], ["TL/USDT", null, "futures-tl-usdt"], ["TL/LTC", "LTC-USD-SPOT", "futures-tl-ltc", "LTC"]]],
      ["Spot Trading", "08-spot", [["TLTC/USDTt", "LTC-USD-SPOT", "spot-tltc"], ["TLt/LTC", "LTC-USD-SPOT", "spot-tl-ltc"]]],
    ];
    for (const [label, name, markets] of plan) {
      if (!(await route(label, name, 5000))) continue;
      for (const [pair, expected, tag, marketType] of markets) {
        if (marketType) { await pickMarket(marketType); await sleep(800); }
        if (name !== "07-futures" || pair !== "BTC/USDT") await pickMarket(pair);
        await sleep(1500);
        if (expected === null) {
          const s = await chartState();
          const emptyShown = await ev(`/no external market/i.test((document.querySelector("tl-bitcorn-chart") || {}).innerText || "")`);
          check(`${label} ${pair}: no-external-market state`, emptyShown, JSON.stringify(s.note));
          await shot(`${name}-${tag}`);
          continue;
        }
        const r = await waitCandle(expected, 60000);
        check(`${label} ${pair}: candle for ${expected} within 60 s`, r.ms !== null, r.ms !== null ? `venue ${r.last.venue}, close ${r.last.close}, after ${(r.ms / 1000).toFixed(1)} s, sources ${JSON.stringify(r.sources.map((x) => x.venue + ":" + x.reason))}` : JSON.stringify(r));
        results.push({ label, pair, expected, venue: r.last && r.last.venue, ms: r.ms });
        await sleep(2500);
        await shot(`${name}-${tag}`);
      }
    }
    writeFileSync(join(out, `${prefix}-chart-results.json`), JSON.stringify(results, null, 2));
    // destroy: leaving the page removes the iframe and its sockets
    await route("Portfolio", "09-after-leave", 1500);
    const gone = await ev(`!document.querySelector("tl-bitcorn-chart") && !document.querySelector("iframe")`);
    check("chart iframe destroyed when the page is left", gone);
  } else {
    for (const [label, name] of [["Spot Trading", "07-spot"], ["Futures Trading", "08-futures"]]) {
      if (routes.includes(label)) {
        await route(label, name, 5000);
        const first = await ev(`(() => { const e = [...document.querySelectorAll("button,div,span")].filter((x) => x.innerText && /\\//.test(x.innerText.trim()) && x.innerText.trim().length < 14 && x.children.length === 0); return e.length; })()`);
        log(`${label}: ${first} market labels`);
      }
    }
  }
  const csp = await ev(`window.__csp || []`).catch(() => []);
  check("no uncaught exceptions", exceptions.length === 0, JSON.stringify(exceptions.slice(0, 3)));
  log(`CSP violations (document events): ${JSON.stringify(csp)}`);
  log(`CSP violations (console): ${JSON.stringify(cspViolations.slice(0, 10))}`);
  log(`blocked requests: ${JSON.stringify(blocked.slice(0, 10))}`);
  writeFileSync(join(out, `${prefix}-console.json`), JSON.stringify({ exceptions, cspViolations, documentCsp: csp, blocked, consoleMessages: consoleMessages.slice(-200) }, null, 2));
  // The market-type icons are third-party image URLs the orderbook server supplies; the CSP has always
  // refused them (img-src 'self' data:) and the skin hides the broken glyph. Everything else must be clean.
  const isIcon = (t) => /img-src|Loading the image/.test(t);
  const other = [...csp, ...cspViolations].filter((t) => !isIcon(t));
  log(`CSP violations other than market icons: ${other.length}; market icon images blocked: ${csp.filter(isIcon).length}`);
  if (withChart) check("no CSP violations other than the market icon images", other.length === 0, JSON.stringify(other.slice(0, 5)));
} catch (e) {
  failures.push(`error: ${e.message}`);
  log(`ERROR ${e.stack || e.message}`);
  writeFileSync(join(out, `${prefix}-console.json`), JSON.stringify({ exceptions, cspViolations, blocked, consoleMessages: consoleMessages.slice(-200) }, null, 2));
} finally {
  try { ws && ws.close(); } catch (_) {}
  if (app) killTree(app.pid);
  try { execFileSync(join(BIN, "bitcoin-cli.exe"), [...cliArgs, "stop"], { stdio: "ignore" }); } catch (_) {}
  await sleep(1500);
  killTree(node.pid);
  await sleep(800);
  try { rmSync(datadir, { recursive: true, force: true }); } catch (_) {}
  if (mock) mock.close();
}
console.log(failures.length ? `CHECK_SKIN_FAIL ${JSON.stringify(failures)}` : "CHECK_SKIN_OK");
process.exit(failures.length ? 1 : 0);
