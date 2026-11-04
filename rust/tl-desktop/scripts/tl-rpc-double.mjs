// TradeLayer RPC TEST DOUBLE for regtest runs.
//
// This is a test double. It does NOT implement TradeLayer consensus, it does not track balances,
// positions, channels or attestations from the chain, and its payloads are NOT valid TradeLayer
// transactions: a real TradeLayer node would reject every one of them. Use it only to drive the
// wallet UI against a plain Bitcoin Core regtest node, where the wallet needs `tl_*` answers with
// the right shapes and the transactions only have to be valid Bitcoin transactions.
//
// Usage:
//   node tl-rpc-double.mjs <listen port> <bitcoind rpc url> <user> <pass> [state.json]
//
// * Listens on 127.0.0.1:<listen port> (0 picks a free port), JSON-RPC 1.0/2.0 over HTTP POST, HTTP
//   basic auth with the same <user>/<pass> the wallet is given.
// * Every method that does not start with `tl_` is forwarded to bitcoind verbatim (request body and
//   URL path, so `/wallet/tl-wallet` reaches that wallet), with the credentials given here.
//   <bitcoind rpc url> must be a loopback http URL.
// * `tl_*` methods are answered here, with the shapes wallet-fe reads:
//     tl_getinfo                      { block, blocktime, ... }       block = bitcoind's height
//     tl_check_kyc [addr]             { "result: ": "enabled(kyc_0)" } for any address
//     tl_getallbalancesforaddress     [{ propertyId, amount, available, reserved }]
//     tl_getproperty [id]             { propertyid, name, ticker, ... }
//     tl_check_commits [addr]         [{ amount, propertyId, block, channel, sender }]
//     tl_getfullposition [addr, cid]  { position, entry_price, BANKRUPTCY_PRICE, position_margin, upnl }
//     tl_listnodereward_addresses     [{ "address:": ... }]
//     tl_isaddresswinner [addr]       { result: "false" }
//     tl_decodetransaction [rawtx]    { valid, ... } recognises this double's OP_RETURN payloads
//     tl_createrawtx_reference        raw tx hex (an output to the address, 0.00000546 by default)
//     tl_createrawtx_opreturn         raw tx hex with an OP_RETURN output carrying the payload
//     tl_createpayload_*              deterministic payload hex: "746c" + method code (1 byte)
//                                     + first 8 bytes of sha256(method "\n" JSON(params))
//   The raw-tx builders call bitcoind's createrawtransaction/decoderawtransaction.
// * Each tl_ call is logged to stdout as one JSON line: {"event":"tl_call","method":...,"params":...,
//   "path":...,"ok":...}. The startup line is {"event":"listening","port":...}.
// * Optional state.json (all keys optional; "*" matches any address):
//     { "balances":   { "<addr>|*": [ { "propertyId": 1, "available": 12.5, "reserved": 0 } ] },
//       "properties": { "<id>": { "name": "...", "ticker": "..." } },
//       "commits":    { "<addr>|*": [ { "amount": "1", "propertyId": 1, "block": 10, "channel": "...", "sender": "..." } ] },
//       "positions":  { "<addr>:<contractId>|*": { "position": "3", "entry_price": "1.5" } },
//       "unattested": [ "<addr>" ] }
//   Without it: zero balances, no commits, flat positions, every address attested.

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const MAX_BODY = 4 << 20;
const DUST_COIN = 0.00000546;

// ------------------------------------------------------------------ arguments

const [portArg, nodeUrlArg, user, pass, statePath] = process.argv.slice(2);
if (portArg === undefined || !nodeUrlArg || user === undefined || pass === undefined) {
  console.error("usage: node tl-rpc-double.mjs <listen port> <bitcoind rpc url> <user> <pass> [state.json]");
  process.exit(2);
}
const listenPort = Number(portArg);
if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
  console.error("listen port must be 0-65535");
  process.exit(2);
}
const nodeUrl = new URL(nodeUrlArg);
if (nodeUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(nodeUrl.hostname)) {
  console.error("bitcoind rpc url must be http on a loopback host");
  process.exit(2);
}
const state = statePath ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const nodeAuth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
const expectedAuth = Buffer.from(nodeAuth);

// ------------------------------------------------------------------ bitcoind access

/** POST a raw body to bitcoind at `path`; resolves { status, body: Buffer }. */
function forward(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: nodeUrl.hostname === "[::1]" ? "::1" : nodeUrl.hostname,
        port: nodeUrl.port || 80,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: nodeAuth },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > 32 << 20) req.destroy(new Error("bitcoind response too large"));
          else chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.setTimeout(60000, () => req.destroy(new Error("bitcoind timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Call bitcoind (node-level, default path) and return `result`, or throw RpcError. */
async function node(method, params = []) {
  const r = await forward("/", JSON.stringify({ jsonrpc: "1.0", id: "double", method, params }));
  let j;
  try {
    j = JSON.parse(r.body.toString("utf8"));
  } catch {
    throw new RpcError(-32603, `bitcoind returned HTTP ${r.status}`);
  }
  if (j.error) throw new RpcError(j.error.code ?? -32603, j.error.message ?? "bitcoind error");
  return j.result;
}

// ------------------------------------------------------------------ tl_ methods

const CODES = {
  attestation: 0x01,
  simplesend: 0x02,
  sendvesting: 0x03,
  sendactivation: 0x04,
  commit_tochannel: 0x10,
  withdrawal_fromchannel: 0x11,
  instant_trade: 0x20,
  instant_ltc_trade: 0x21,
  contract_instant_trade: 0x22,
};
const MIN_PARAMS = {
  attestation: 0,
  simplesend: 2,
  sendvesting: 1,
  sendactivation: 3,
  commit_tochannel: 2,
  withdrawal_fromchannel: 2,
  instant_trade: 5,
  instant_ltc_trade: 4,
  contract_instant_trade: 6,
};
const TAG = "746c";

function payloadFor(name, params) {
  const code = (CODES[name] ?? 0xff).toString(16).padStart(2, "0");
  const h = createHash("sha256").update(`${name}\n${JSON.stringify(params)}`).digest("hex").slice(0, 16);
  return TAG + code + h;
}

const byAddress = (table, addr) => (table && (table[addr] ?? table["*"])) || undefined;
const str = (v, what) => {
  if (typeof v !== "string" || v.length === 0 || v.length > 200) throw new RpcError(-8, `${what} must be a non-empty string`);
  return v;
};
const isHex = (s) => typeof s === "string" && s.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(s);

/** The raw tx of `rawtx` ("" = empty) with `add` outputs appended, via bitcoind. */
async function withOutputs(rawtx, add) {
  let inputs = [];
  let outputs = [];
  let locktime = 0;
  if (rawtx) {
    if (!isHex(rawtx)) throw new RpcError(-22, "rawtx must be hex");
    const d = await node("decoderawtransaction", [rawtx]);
    inputs = d.vin.map((v) => ({ txid: v.txid, vout: v.vout, sequence: v.sequence }));
    outputs = d.vout.map((o) => {
      if (o.scriptPubKey.type === "nulldata") return { data: o.scriptPubKey.asm.split(" ")[1] ?? "" };
      if (!o.scriptPubKey.address) throw new RpcError(-22, "output without an address");
      return { [o.scriptPubKey.address]: o.value };
    });
    locktime = d.locktime;
  }
  for (const o of add) {
    const key = Object.keys(o)[0];
    if (key !== "data" && outputs.some((e) => key in e)) continue; // reference output already present
    outputs.push(o);
  }
  return node("createrawtransaction", [inputs, outputs, locktime]);
}

const handlers = {
  async tl_getinfo() {
    const c = await node("getblockchaininfo");
    return { block: c.blocks, blocktime: c.time ?? c.mediantime ?? 0, blocktransactions: 0, version: 1, test_double: true };
  },
  async tl_check_kyc(p) {
    const a = str(p[0], "address");
    return { "result: ": (state.unattested ?? []).includes(a) ? "disabled" : "enabled(kyc_0)" };
  },
  async tl_getallbalancesforaddress(p) {
    const a = str(Array.isArray(p) ? p[0] : p, "address");
    const configured = byAddress(state.balances, a);
    const rows = configured ?? (Object.keys(state.properties ?? { 1: 1 })).map((id) => ({ propertyId: Number(id), available: 0, reserved: 0 }));
    return rows.map((r) => {
      const available = Number(r.available ?? 0);
      const reserved = Number(r.reserved ?? 0);
      return {
        propertyId: String(r.propertyId),
        amount: Number((available + reserved).toFixed(8)),
        available,
        reserved: reserved.toFixed(8),
      };
    });
  },
  async tl_getproperty(p) {
    const id = Number(p[0]);
    if (!Number.isInteger(id) || id < 0) throw new RpcError(-8, "Invalid property identifier");
    const cfg = (state.properties ?? {})[String(id)] ?? {};
    return { propertyid: id, name: cfg.name ?? `Token ${id}`, ticker: cfg.ticker ?? `T${id}`, divisible: true, totaltokens: "0.00000000" };
  },
  async tl_check_commits(p) {
    const a = str(p[0], "address");
    return byAddress(state.commits, a) ?? [];
  },
  async tl_getfullposition(p) {
    const a = str(p[0], "address");
    const cid = String(p[1]);
    const flat = { position: "0", entry_price: "0", BANKRUPTCY_PRICE: "0", position_margin: "0", upnl: "0" };
    return { ...flat, ...(byAddress(state.positions, `${a}:${cid}`) ?? {}) };
  },
  async tl_listnodereward_addresses() {
    return [];
  },
  async tl_isaddresswinner(p) {
    str(p[0], "address");
    return { result: "false" };
  },
  async tl_decodetransaction(p) {
    const raw = str(p[0], "rawtx");
    if (!isHex(raw)) throw new RpcError(-22, "rawtx must be hex");
    const d = await node("decoderawtransaction", [raw]);
    const carrier = d.vout.find((o) => o.scriptPubKey.type === "nulldata");
    const payload = carrier?.scriptPubKey.asm.split(" ")[1];
    if (!payload || !payload.toLowerCase().startsWith(TAG)) return { txid: d.txid, valid: false, reason: "no tl-rpc-double payload" };
    const code = parseInt(payload.slice(4, 6), 16);
    const method = Object.keys(CODES).find((k) => CODES[k] === code) ?? "unknown";
    return { txid: d.txid, valid: true, test_double: true, type: method, payload };
  },
  async tl_createrawtx_reference(p) {
    const dest = str(p[1], "destination");
    const amount = p[2] === undefined ? DUST_COIN : Number(p[2]);
    if (!(amount > 0) || amount > 21e6) throw new RpcError(-3, "Invalid amount");
    return withOutputs(p[0] ?? "", [{ [dest]: amount }]);
  },
  async tl_createrawtx_opreturn(p) {
    const payload = str(p[1], "payload");
    if (!isHex(payload) || payload.length > 160) throw new RpcError(-22, "payload must be hex of at most 80 bytes");
    return withOutputs(p[0] ?? "", [{ data: payload }]);
  },
};

async function answerTl(method, params) {
  const m = /^tl_createpayload_([a-z0-9_]+)$/.exec(method);
  if (m) {
    const name = m[1];
    if (!Array.isArray(params)) throw new RpcError(-32602, "params must be an array");
    if (params.length < (MIN_PARAMS[name] ?? 0)) throw new RpcError(-32602, `${method} needs ${MIN_PARAMS[name]} parameters`);
    return payloadFor(name, params);
  }
  const h = Object.hasOwn(handlers, method) ? handlers[method] : null;
  if (!h) throw new RpcError(-32601, `Method not found: ${method} (tl-rpc-double)`);
  if (!Array.isArray(params) && !(method === "tl_getallbalancesforaddress" && typeof params === "string")) {
    if (params === undefined || params === null) params = [];
    else throw new RpcError(-32602, "params must be an array");
  }
  return h(params);
}

// ------------------------------------------------------------------ HTTP

function authorised(header) {
  const got = Buffer.from(header ?? "");
  return got.length === expectedAuth.length && timingSafeEqual(got, expectedAuth);
}

function reply(res, status, body, extra = {}) {
  const buf = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(buf), ...extra });
  res.end(buf);
}

const httpStatusFor = (code) => (code === -32601 ? 404 : code === -32600 ? 400 : 500);

async function handleOne(call, path) {
  const { method, params, id } = call ?? {};
  const v2 = call?.jsonrpc === "2.0";
  const envelope = (result, error) =>
    v2 ? (error ? { jsonrpc: "2.0", error, id: id ?? null } : { jsonrpc: "2.0", result, id: id ?? null })
       : { result: error ? null : result, error: error ?? null, id: id ?? null };
  if (typeof method !== "string") return { status: 400, body: envelope(null, { code: -32600, message: "Invalid Request object" }) };
  if (!method.startsWith("tl_")) {
    const r = await forward(path, JSON.stringify(call));
    let body;
    try {
      body = JSON.parse(r.body.toString("utf8"));
    } catch {
      body = envelope(null, { code: -32603, message: `bitcoind returned HTTP ${r.status}` });
    }
    return { status: r.status, body };
  }
  let ok = true;
  let out;
  try {
    out = { status: 200, body: envelope(await answerTl(method, params)) };
  } catch (e) {
    ok = false;
    const code = e instanceof RpcError ? e.code : -32603;
    out = { status: httpStatusFor(code), body: envelope(null, { code, message: e.message }) };
  }
  console.log(JSON.stringify({ event: "tl_call", method, params: params ?? [], path, ok }));
  return out;
}

const server = http.createServer((req, res) => {
  if (!authorised(req.headers.authorization)) {
    return reply(res, 401, "", { "www-authenticate": 'Basic realm="jsonrpc"' });
  }
  if (req.method !== "POST") return reply(res, 405, { error: "POST only" });
  const path = req.url && req.url.startsWith("/") && !req.url.includes("..") ? req.url : "/";
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      reply(res, 413, { error: "body too large" });
      req.destroy();
    } else chunks.push(c);
  });
  req.on("end", async () => {
    if (res.writableEnded) return;
    try {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(res, 400, { result: null, error: { code: -32700, message: "Parse error" }, id: null });
      }
      if (Array.isArray(parsed)) {
        const outs = [];
        for (const c of parsed) outs.push((await handleOne(c, path)).body);
        return reply(res, 200, outs);
      }
      if (typeof parsed?.method === "string" && !parsed.method.startsWith("tl_")) {
        // single non-tl_ request: the original bytes go to bitcoind and its answer comes back as is
        const r = await forward(path, Buffer.concat(chunks).toString("utf8"));
        return reply(res, r.status, r.body);
      }
      const { status, body } = await handleOne(parsed, path);
      reply(res, status, body);
    } catch (e) {
      reply(res, 502, { result: null, error: { code: -32603, message: `double: ${e.message}` }, id: null });
    }
  });
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "listening", port: server.address().port }));
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
