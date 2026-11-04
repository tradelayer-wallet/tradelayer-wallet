// Render check for the FE-speed UI inside the Tauri window (WebView2 DevTools protocol).
//
// Usage: node scripts/check-fe-speed-ui.mjs <cdp port> <out dir> [settle ms] [--click "Button text"]...
//
// Each --click, in order, presses the first <button> whose text contains the given text after the
// first settle and waits 5 s, so the requests of later screens (for example "Select Network") are
// recorded as well.
//
// Start the test exe first with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>
// (and TL_DESKTOP_CONFIG pointing at a nonexistent file). The script reloads the page so the whole
// bootstrap is observed, waits `settle ms` (default 15000), then writes into <out dir>:
//   fe-speed-render.png       screenshot
//   fe-speed-report.json      console messages, exceptions, every request with its status, DOM facts
//   fe-speed-requests.txt     requests that failed or answered >= 400 (URL + status): the backend
//                             routes the Rust side still has to serve
// Exit code 0 when the UI bootstrapped (<tl-root> rendered, bridge present, no Electron-bridge
// exception), 1 otherwise, 2 when no page is reachable.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const clicks = [];
for (let i = argv.length - 1; i >= 0; i--) if (argv[i] === "--click") clicks.unshift(...argv.splice(i, 2).slice(1));
const [port, outArg, msArg] = argv;
if (!port || !outArg) {
  console.error("usage: check-fe-speed-ui.mjs <cdp port> <out dir> [settle ms]");
  process.exit(2);
}
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const settle = Number(msArg || 15000);
const sleep = (t) => new Promise((r) => setTimeout(r, t));

let page;
for (let i = 0; i < 60 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch (_) {}
  if (!page) await sleep(500);
}
if (!page) { console.error("NO_PAGE"); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 0;
const waiting = new Map();
const consoleMessages = [];
const exceptions = [];
const requests = new Map();
const text = (a) => String(a.value ?? a.description ?? a.type);

ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); return; }
  const p = msg.params || {};
  switch (msg.method) {
    case "Runtime.consoleAPICalled":
      consoleMessages.push({ type: p.type, text: p.args.map(text).join(" ").slice(0, 600) });
      break;
    case "Runtime.exceptionThrown":
      exceptions.push((p.exceptionDetails.exception?.description || p.exceptionDetails.text).slice(0, 1000));
      break;
    case "Log.entryAdded":
      consoleMessages.push({ type: `log.${p.entry.level}`, text: `${p.entry.text} ${p.entry.url || ""}`.slice(0, 600) });
      break;
    case "Network.requestWillBeSent":
      requests.set(p.requestId, { method: p.request.method, url: p.request.url, status: null, failure: null });
      break;
    case "Network.responseReceived": {
      const r = requests.get(p.requestId);
      if (r) r.status = p.response.status;
      break;
    }
    case "Network.loadingFailed": {
      const r = requests.get(p.requestId);
      if (r) r.failure = `${p.errorText}${p.blockedReason ? " blocked:" + p.blockedReason : ""}${p.corsErrorStatus ? " cors:" + p.corsErrorStatus.corsError : ""}`;
      break;
    }
  }
};
const send = (method, params = {}) => new Promise((resolveSend) => {
  const id = ++nextId;
  waiting.set(id, resolveSend);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.exceptionDetails ? { exception: r.result.exceptionDetails.text } : r.result?.result?.value;
};

await Promise.all([send("Runtime.enable"), send("Log.enable"), send("Network.enable"), send("Page.enable")]);
await send("Page.reload", { ignoreCache: true });
await sleep(settle);
const clicked = [];
for (const label of clicks) {
  clicked.push({ label, result: await evaluate(`(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.innerText.includes(${JSON.stringify(label)}) && !x.disabled);
    if (!b) return "not found";
    b.click();
    return "clicked";
  })()`) });
  await sleep(5000);
}

const dom = await evaluate(`(() => {
  const root = document.querySelector("tl-root");
  return {
    href: location.href,
    title: document.title,
    rootChildren: root ? root.children.length : -1,
    bridge: typeof window.tradelayerElectron,
    bridgeFrozen: window.tradelayerElectron ? Object.isFrozen(window.tradelayerElectron) : null,
    legacyRequire: typeof window.require,
    text: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 1500),
  };
})()`);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(out, "fe-speed-render.png"), Buffer.from(shot.result.data, "base64"));
ws.close();

const all = [...requests.values()];
const bad = all.filter((r) => r.failure || r.status >= 400);
const pending = all.filter((r) => r.status === null && !r.failure); // open socket.io long polls at capture time
writeFileSync(join(out, "fe-speed-report.json"), JSON.stringify({ dom, clicked, exceptions, consoleMessages, requests: all }, null, 2));
writeFileSync(
  join(out, "fe-speed-requests.txt"),
  bad.map((r) => `${r.status ?? "-"}\t${r.method}\t${r.url}${r.failure ? `\t${r.failure}` : ""}`).join("\n") + "\n",
);

const bridgeErrors = exceptions.filter((e) => /tradelayerElectron|Blocked IPC|window\.require|require is not/.test(e));
console.log(JSON.stringify({ dom: { ...dom, text: String(dom.text).slice(0, 200) }, exceptions: exceptions.length, bridgeErrors: bridgeErrors.length, requests: all.length, failedOrError: bad.length, pending: pending.length, clicked }, null, 2));
const ok = dom && dom.rootChildren > 0 && dom.bridge === "object" && bridgeErrors.length === 0;
console.log(ok ? "RENDER_OK" : "RENDER_FAILED");
process.exit(ok ? 0 : 1);
