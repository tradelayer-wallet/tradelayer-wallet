// TradeLayer LISTENER TEST DOUBLE for regtest runs of the FE-speed wallet UI.
//
// This is a test double. It does NOT implement TradeLayer consensus. It reads the payload strings
// FE-speed's own encoder writes into OP_RETURN outputs (`tl4...` commit, `tlk...` channel trade) from
// the transactions a plain Bitcoin Core regtest node sees, applies them with simple bookkeeping (no
// validity rules beyond "the committer holds the amount"), and answers the HTTP endpoints of the
// listener on :3000 (`tl_listener_url`) with the shapes wallet-fe parses. A real TradeLayer node would
// judge the same transactions differently. Use it only to drive the wallet UI end to end against a
// node that has no TradeLayer parser.
//
// Usage:
//   node tl-listener-double.mjs <listen port> <bitcoind rpc url> <user> <pass> [config.json]
//
// Serves (verb as in docs/listener-map.md; POST bodies are JSON, GET parameters are query strings):
//   POST tl_initmain, tl_getSyncStatus, tl_checkSync, tl_getMaxProcessedHeight, tl_getMaxParsedHeight,
//        tl_getTrackHeight, tl_loadWallet, tl_getStateSnapshot
//   POST tl_getAllBalancesForAddress {params: addr | address}  -> [{propertyId, ticker, amount, available,
//        reserved, margin, vesting, channel}]
//   POST tl_listProperties, tl_getProperty {params: id}
//   POST tl_getChannel {params: addr}  addr is the channel or one of its participants
//        -> {channel, participants: {A, B}, commits: [...], balances: {A: {...}, B: {...}}} or {error}
//   POST tl_getChannelColumn {channelAddress, newCommitAddress|buyerAddress, cpAddress} -> "A" | "B"
//   POST tl_getAttestations {address, id} -> [{data: {status: "active", ...}}] (every address, except
//        config "unattested")
//   POST tl_getTransaction {txid}, tl_getClearlistById, tl_listContractSeries, tl_watchonly_register,
//        tl_watchonly_utxos
//   GET  tl_getInitMargin, tl_getContractInfo, tl_contractPosition (flat), tl_channelBalanceForCommiter
//        ({total, rows}), tl_tokenTradeHistoryForAddress (rows from observed channel trades),
//        tl_contractTradeHistoryForAddress, tl_totalTradeHistoryForAddress, tl_contractTradeHistory,
//        tl_fundingHistory, tl_oracleHistory, tl_getMaxSynth
//   GET/POST __test/state (read, merge config), __test/calls (log of calls)
//
// What it observes. It follows the node (blocks with `getblock <hash> 3`, then the mempool) and keeps
// every transaction whose OP_RETURN starts with `tl`:
//   * commit `tl4<prop>,<amount>,<ref:0|addr>` (base 36, amount in 1e-8 units): the sender is the
//     address of the first input; the channel is the first non-change output paying a script longer
//     than a pubkey-hash address (P2WSH multisig). The first committer of a channel is column A, the
//     second is column B. Channel membership and columns count mempool commits too, because the
//     buyer asks for its column right after the seller broadcast its commit.
//   * channel trade `tlk<p1>,<p2>,<amt1>,<amt2>,<colAIsOfferer>,<expiry>,<colAIsMaker>`: moves channel
//     balances between the two participants once it is mined (if the offerer holds amt1 of p1 in the
//     channel and the counterparty amt2 of p2; otherwise it is recorded as invalid and moves nothing).
//   Balances (`available`, `channel`) and trade history come from mined transactions only.
//
// config.json (all keys optional; "*" matches any address):
//   { "balances":   { "<addr>|*": [ { "propertyId": 1, "available": 12.5, "reserved": 0, "margin": 0 } ] },
//     "properties": { "<id>": { "name": "...", "ticker": "..." } },
//     "unattested": [ "<addr>" ], "initMargin": 0.05 }
// Without it every address holds nothing and is attested.
//
// Each call is logged as one JSON line {"event":"tl_listener_call","endpoint":...,"ok":...}; the
// startup line is {"event":"listening","port":...}.
import http from "node:http";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const MAX_BODY = 1 << 20;
const COIN = 100000000n;

// ------------------------------------------------------------------ payload parsing

/** `tl` + base-36 type digit(s) + payload, from the hex of an OP_RETURN push, or null. */
export function decodePayload(hex) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) return null;
  const text = Buffer.from(hex, "hex").toString("latin1");
  if (!text.startsWith("tl") || text.length < 4) return null;
  const rest = text.slice(2);
  const m = /^([0-9a-z])(.*)$/s.exec(rest);
  if (!m) return null;
  const type = parseInt(m[1], 36);
  const f = m[2].split(",");
  const atoms = (s) => {
    if (!/^[0-9a-z]+$/.test(s)) throw new Error("bad amount");
    let v = 0n;
    for (const ch of s) v = v * 36n + BigInt(parseInt(ch, 36));
    return v;
  };
  const id = (s) => {
    if (!/^[0-9a-z]+$/.test(s)) throw new Error("bad id");
    return parseInt(s, 36);
  };
  try {
    if (type === 4 && f.length === 3) return { kind: "commit", propertyId: id(f[0]), atoms: atoms(f[1]), channelRef: f[2] };
    if (type === 20 && f.length === 7) {
      return {
        kind: "trade",
        propertyId1: id(f[0]),
        propertyId2: id(f[1]),
        atoms1: atoms(f[2]),
        atoms2: atoms(f[3]),
        columnAIsOfferer: f[4] === "1",
        expiryBlock: id(f[5]),
        columnAIsMaker: f[6] === "1",
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** Parse one decoded tx (verbosity 2/3 shape: vin[].prevout, vout[].scriptPubKey) or null if it carries no tl payload. */
export function parseTx(tx) {
  const carrier = (tx.vout || []).find((o) => o.scriptPubKey?.type === "nulldata");
  if (!carrier) return null;
  const hex = (carrier.scriptPubKey.asm || "").split(" ")[1];
  const payload = decodePayload(hex);
  if (!payload) return null;
  const sender = tx.vin?.[0]?.prevout?.scriptPubKey?.address ?? null;
  // a commit pays the channel; a channel trade spends the commit output sitting at the channel
  const longAddr = (a) => typeof a === "string" && a.length > 42;
  const channelOut = (tx.vout || []).find((o) => o.scriptPubKey?.type !== "nulldata" && longAddr(o.scriptPubKey?.address))?.scriptPubKey.address ?? null;
  const channelIn = (tx.vin || []).find((i) => longAddr(i.prevout?.scriptPubKey?.address))?.prevout.scriptPubKey.address ?? null;
  return { txid: tx.txid, sender, channel: payload.kind === "trade" ? channelIn : channelOut, ...payload };
}

// ------------------------------------------------------------------ the double

const toAtoms = (v) => BigInt(Math.round(Number(v ?? 0) * 1e8));
const toCoins = (a) => Number(a) / 1e8;
const byAddress = (table, addr) => (table && (table[addr] ?? table["*"])) || undefined;

export function createListenerDouble({ nodeUrl, user, pass, config = {}, log = true }) {
  const nodeAuth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const base = new URL(nodeUrl);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("bitcoind rpc url must be http on a loopback host");
  const cfg = JSON.parse(JSON.stringify(config));
  const calls = [];
  const chain = new Map(); // height -> { hash, txs: [parsed] }
  let mempool = new Map(); // txid -> parsed
  let tip = 0;

  async function node(method, params = []) {
    const body = JSON.stringify({ jsonrpc: "1.0", id: "listener-double", method, params });
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: base.hostname === "[::1]" ? "::1" : base.hostname, port: base.port || 80, path: "/", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: nodeAuth } },
        (r) => {
          const chunks = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      req.setTimeout(30000, () => req.destroy(new Error("bitcoind timeout")));
      req.on("error", reject);
      req.end(body);
    });
    const j = JSON.parse(res);
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
    return j.result;
  }

  /** Follow the node: new blocks (with a reorg check) and the mempool. */
  async function scan() {
    const height = await node("getblockcount");
    // drop heights whose hash changed (reorg)
    for (let h = Math.min(tip, height); h >= 1 && chain.has(h); h--) {
      if ((await node("getblockhash", [h])) === chain.get(h).hash) break;
      chain.delete(h);
    }
    for (let h = [...chain.keys()].reduce((a, b) => Math.max(a, b), 0) + 1; h <= height; h++) {
      const hash = await node("getblockhash", [h]);
      const blk = await node("getblock", [hash, 3]);
      chain.set(h, { hash, txs: blk.tx.map(parseTx).filter(Boolean) });
    }
    for (const h of [...chain.keys()]) if (h > height) chain.delete(h);
    tip = height;
    const mined = new Set([...chain.values()].flatMap((b) => b.txs.map((t) => t.txid)));
    const next = new Map();
    for (const txid of await node("getrawmempool", [false])) {
      if (mined.has(txid)) continue;
      if (mempool.has(txid)) {
        next.set(txid, mempool.get(txid));
        continue;
      }
      try {
        const parsed = parseTx(await node("getrawtransaction", [txid, 2]));
        next.set(txid, parsed); // null for a tx without a tl payload: not looked up again
      } catch {
        // evicted between the two calls
      }
    }
    mempool = next;
  }

  /** Everything the double knows, derived from the observed transactions and the config. */
  function derive() {
    const channels = new Map(); // address -> { channel, participants: {A,B}, commits: [], chan: Map(addr -> Map(prop -> atoms)) }
    const avail = new Map(); // addr -> Map(prop -> atoms taken out of available)
    const trades = [];
    const ordered = [];
    for (const [height, b] of [...chain.entries()].sort((a, b) => a[0] - b[0])) for (const t of b.txs) ordered.push({ ...t, block: height, confirmed: true });
    for (const t of mempool.values()) if (t) ordered.push({ ...t, block: null, confirmed: false });
    const bal = (m, a, p) => m.get(a)?.get(p) ?? 0n;
    const add = (m, a, p, d) => {
      if (!m.has(a)) m.set(a, new Map());
      m.get(a).set(p, bal(m, a, p) + d);
    };
    for (const t of ordered) {
      if (t.kind === "commit" && t.sender && t.channel) {
        if (!channels.has(t.channel)) channels.set(t.channel, { channel: t.channel, participants: {}, commits: [], chan: new Map() });
        const ch = channels.get(t.channel);
        if (ch.participants.A !== t.sender && ch.participants.B !== t.sender) {
          if (!ch.participants.A) ch.participants.A = t.sender;
          else if (!ch.participants.B) ch.participants.B = t.sender;
        }
        ch.commits.push({ txid: t.txid, sender: t.sender, propertyId: t.propertyId, amount: toCoins(t.atoms), block: t.block, confirmed: t.confirmed });
        if (t.confirmed) {
          const have = availableAtoms(t.sender, t.propertyId, avail);
          if (have >= t.atoms) {
            add(avail, t.sender, t.propertyId, t.atoms);
            add(ch.chan, t.sender, t.propertyId, t.atoms);
          } else ch.commits[ch.commits.length - 1].invalid = "amount exceeds the available balance";
        }
      } else if (t.kind === "trade" && t.confirmed) {
        const ch = channels.get(t.channel);
        const row = { txid: t.txid, block: t.block, channel: ch?.channel ?? null, propertyId1: t.propertyId1, propertyId2: t.propertyId2, amount1: toCoins(t.atoms1), amount2: toCoins(t.atoms2) };
        if (!ch || !ch.participants.A || !ch.participants.B) {
          trades.push({ ...row, invalid: "no channel with two participants" });
          continue;
        }
        const offerer = t.columnAIsOfferer ? ch.participants.A : ch.participants.B;
        const taker = t.columnAIsOfferer ? ch.participants.B : ch.participants.A;
        if (bal(ch.chan, offerer, t.propertyId1) < t.atoms1 || bal(ch.chan, taker, t.propertyId2) < t.atoms2) {
          trades.push({ ...row, offerer, taker, invalid: "channel balance too low" });
          continue;
        }
        add(ch.chan, offerer, t.propertyId1, -t.atoms1);
        add(ch.chan, taker, t.propertyId1, t.atoms1);
        add(ch.chan, taker, t.propertyId2, -t.atoms2);
        add(ch.chan, offerer, t.propertyId2, t.atoms2);
        // the buyer of the pair's base token (the lower property id) is whoever received it
        const baseId = Math.min(t.propertyId1, t.propertyId2);
        const baseAtoms = baseId === t.propertyId1 ? t.atoms1 : t.atoms2;
        const quoteAtoms = baseId === t.propertyId1 ? t.atoms2 : t.atoms1;
        const buyer = baseId === t.propertyId1 ? taker : offerer;
        const seller = buyer === offerer ? taker : offerer;
        trades.push({
          ...row,
          offerer,
          taker,
          buyer,
          seller,
          baseId,
          quoteId: Math.max(t.propertyId1, t.propertyId2),
          amountOffered: toCoins(baseAtoms),
          amountExpected: toCoins(quoteAtoms),
          price: baseAtoms === 0n ? 0 : Number(quoteAtoms) / Number(baseAtoms),
          takerFee: 0,
        });
      }
    }
    return { channels, avail, trades };
  }

  function configured(addr) {
    return (byAddress(cfg.balances, addr) || []).map((r) => ({
      propertyId: Number(r.propertyId),
      available: toAtoms(r.available),
      reserved: toAtoms(r.reserved),
      margin: toAtoms(r.margin),
      vesting: toAtoms(r.vesting),
    }));
  }
  function availableAtoms(addr, prop, avail) {
    const row = configured(addr).find((r) => r.propertyId === prop);
    return (row?.available ?? 0n) - (avail.get(addr)?.get(prop) ?? 0n);
  }
  const ticker = (id) => cfg.properties?.[String(id)]?.ticker ?? `T${id}`;
  const propRow = (id) => ({
    id,
    propertyId: id,
    issuer: cfg.properties?.[String(id)]?.issuer ?? "test-double",
    kind: "fixed",
    name: cfg.properties?.[String(id)]?.name ?? `Token ${id}`,
    ticker: ticker(id),
    divisible: true,
    totalSupply: 1000000,
    test_double: true,
  });
  const propertyIds = () => [...new Set([...Object.keys(cfg.properties ?? {}).map(Number), ...Object.values(cfg.balances ?? {}).flatMap((rows) => rows.map((r) => Number(r.propertyId)))])].sort((a, b) => a - b);

  function balancesFor(addr) {
    const { channels, avail } = derive();
    const rows = new Map();
    for (const r of configured(addr)) {
      rows.set(r.propertyId, { ...r, available: r.available - (avail.get(addr)?.get(r.propertyId) ?? 0n), channel: 0n });
    }
    for (const ch of channels.values()) {
      for (const [p, atoms] of ch.chan.get(addr) ?? []) {
        if (!rows.has(p)) rows.set(p, { propertyId: p, available: 0n, reserved: 0n, margin: 0n, vesting: 0n, channel: 0n });
        rows.get(p).channel += atoms;
      }
    }
    return [...rows.values()]
      .sort((a, b) => a.propertyId - b.propertyId)
      .map((r) => ({
        propertyId: String(r.propertyId),
        ticker: ticker(r.propertyId),
        amount: toCoins(r.available + r.reserved + r.channel),
        available: toCoins(r.available),
        reserved: toCoins(r.reserved),
        margin: toCoins(r.margin),
        vesting: toCoins(r.vesting),
        channel: toCoins(r.channel),
      }));
  }

  function channelView(ch) {
    const out = { channel: ch.channel, participants: ch.participants, commits: ch.commits, balances: {} };
    for (const col of ["A", "B"]) {
      const addr = ch.participants[col];
      out.balances[col] = Object.fromEntries([...(ch.chan.get(addr) ?? [])].map(([p, a]) => [p, toCoins(a)]));
    }
    return out;
  }

  const bodyAddress = (b, q) => {
    const v = b?.params ?? b?.address ?? q.get("address");
    return Array.isArray(v) ? v[0] : v;
  };

  const heights = () => ({ h: tip });
  const handlers = {
    tl_initmain: () => ({ initialized: true, test_double: true, network: "regtest", finalizedHeight: tip }),
    tl_getSyncStatus: () => ({ source: "test-double", available: true, consensus: tip, txIndex: tip, trackHeight: tip, synced: true, processedCount: [...chain.values()].reduce((n, b) => n + b.txs.length, 0) }),
    tl_checkSync: () => ({ available: true, consensus: tip, txIndex: tip, trackHeight: tip, synced: true }),
    tl_getMaxProcessedHeight: () => ({ maxProcessedHeight: heights().h }),
    tl_getMaxParsedHeight: () => ({ maxParsedHeight: heights().h }),
    tl_getTrackHeight: () => ({ trackHeight: heights().h, source: "test-double" }),
    tl_loadWallet: () => ({ loaded: true, test_double: true }),
    tl_getStateSnapshot: () => ({ height: tip, test_double: true, channels: [...derive().channels.values()].map(channelView) }),
    tl_getAllBalancesForAddress: (b, q) => {
      const a = bodyAddress(b, q);
      if (typeof a !== "string" || !a) throw httpError(400, "address required");
      return balancesFor(a);
    },
    tl_listProperties: () => propertyIds().map(propRow),
    tl_getProperty: (b, q) => {
      const raw = Array.isArray(b?.params) ? b.params[0] : (b?.params ?? q.get("id"));
      const id = Number(raw);
      if (!Number.isInteger(id) || id < 0) throw httpError(400, "invalid property id");
      return propRow(id);
    },
    tl_getChannel: (b, q) => {
      const a = bodyAddress(b, q);
      const { channels } = derive();
      const ch = [...channels.values()].find((c) => c.channel === a || c.participants.A === a || c.participants.B === a);
      return ch ? channelView(ch) : { error: "No channel found" };
    },
    tl_getChannelColumn: (b) => {
      const body = b || {};
      const channelAddress = body.channelAddress ?? body.channel;
      const mine = body.newCommitAddress ?? body.myAddress ?? body.buyerAddress;
      const cp = body.cpAddress;
      if (!channelAddress || !mine || !cp) throw httpError(400, "channelAddress, newCommitAddress and cpAddress are required");
      const ch = derive().channels.get(channelAddress);
      if (!ch) return "A";
      if (ch.participants.A === mine) return "A";
      if (ch.participants.B === mine) return "B";
      if (ch.participants.A === cp) return "B";
      if (ch.participants.B === cp) return "A";
      return ch.participants.A ? "B" : "A";
    },
    tl_getAttestations: (b) => {
      const address = b?.address ?? (Array.isArray(b?.params) ? b.params[0] : undefined);
      if (typeof address !== "string" || !address) throw httpError(400, "address required");
      if ((cfg.unattested ?? []).includes(address)) return [];
      return [{ data: { status: "active", address, kyc: 0, test_double: true }, block: 1 }];
    },
    tl_getTransaction: (b) => {
      const txid = b?.txid ?? (Array.isArray(b?.params) ? b.params[0] : b?.params);
      for (const [h, blk] of chain) for (const t of blk.txs) if (t.txid === txid) return { ...serial(t), block: h, confirmed: true };
      const m = mempool.get(txid);
      return m ? { ...serial(m), block: null, confirmed: false } : { error: "not found" };
    },
    tl_getClearlistById: () => ({}),
    tl_listContractSeries: () => [],
    tl_watchonly_register: () => ({ registered: true, test_double: true }),
    tl_watchonly_utxos: () => [],
    tl_getInitMargin: () => cfg.initMargin ?? 0.05,
    tl_getContractInfo: (b, q) => ({ contractId: Number(q.get("contractId")), collateralPropertyId: 5, inverse: false, leverage: 1, test_double: true }),
    tl_contractPosition: () => ({ position: "0", entry_price: "0", BANKRUPTCY_PRICE: "0", position_margin: "0", upnl: "0" }),
    tl_channelBalanceForCommiter: (b, q) => {
      const addr = q.get("address");
      const pidRaw = q.get("propertyId");
      const { channels } = derive();
      const rows = [];
      for (const ch of channels.values()) {
        for (const col of ["A", "B"]) {
          if (ch.participants[col] !== addr) continue;
          for (const [p, atoms] of ch.chan.get(addr) ?? []) {
            if (pidRaw !== null && pidRaw !== "" && Number(pidRaw) !== p) continue;
            const last = [...ch.commits].reverse().find((c) => c.sender === addr && c.propertyId === p && c.block !== null);
            rows.push({ channel: ch.channel, column: col, propertyId: p, amount: toCoins(atoms), participants: ch.participants, counterparty: ch.participants[col === "A" ? "B" : "A"], lastCommitmentBlock: last?.block });
          }
        }
      }
      return { total: rows.length, rows };
    },
    tl_tokenTradeHistoryForAddress: (b, q) => {
      const addr = q.get("address");
      const p1 = Number(q.get("propertyId1"));
      const p2 = Number(q.get("propertyId2"));
      return derive()
        .trades.filter((t) => !t.invalid && (t.buyer === addr || t.seller === addr) && new Set([t.propertyId1, t.propertyId2]).has(p1) && new Set([t.propertyId1, t.propertyId2]).has(p2))
        .map((t) => ({ block: t.block, buyer: t.buyer, seller: t.seller, price: t.price, amountOffered: t.amountOffered, amountExpected: t.amountExpected, takerFee: t.takerFee, txid: t.txid }));
    },
    tl_contractTradeHistoryForAddress: () => [],
    tl_totalTradeHistoryForAddress: (b, q) => {
      const addr = q.get("address");
      return derive().trades.filter((t) => !t.invalid && (t.buyer === addr || t.seller === addr)).map(serial);
    },
    tl_contractTradeHistory: () => [],
    tl_fundingHistory: () => [],
    tl_oracleHistory: () => [],
    tl_getMaxSynth: () => ({ maxSynth: 0 }),
  };
  const POST_ONLY = new Set(["tl_initmain", "tl_getSyncStatus", "tl_checkSync", "tl_getMaxProcessedHeight", "tl_getMaxParsedHeight", "tl_getTrackHeight", "tl_loadWallet", "tl_getStateSnapshot", "tl_getAllBalancesForAddress", "tl_getChannel", "tl_getChannelColumn", "tl_listProperties", "tl_getProperty", "tl_getAttestations", "tl_getTransaction", "tl_getClearlistById", "tl_listContractSeries", "tl_watchonly_register", "tl_watchonly_utxos"]);

  const serial = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? toCoins(v) : v)));
  const httpError = (status, message) => Object.assign(new Error(message), { status });

  function send(res, status, body) {
    const buf = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(buf) });
    res.end(buf);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const endpoint = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        send(res, 413, { error: "body too large" });
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", async () => {
      if (res.writableEnded) return;
      let body;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: "invalid JSON" });
        }
      }
      let ok = true;
      const reply = (status, out) => {
        ok = status < 400;
        return send(res, status, out);
      };
      try {
        if (endpoint === "__test/state") {
          if (req.method === "POST") {
            for (const k of ["balances", "properties", "unattested", "initMargin"]) if (body?.[k] !== undefined) cfg[k] = body[k];
          }
          return reply(200, { config: cfg, height: tip, chain: [...chain].map(([h, b]) => ({ h, txs: b.txs.map(serial) })).filter((x) => x.txs.length), mempool: [...mempool.values()].filter(Boolean).map(serial) });
        }
        if (endpoint === "__test/calls") return reply(200, calls);
        const h = Object.hasOwn(handlers, endpoint) ? handlers[endpoint] : null;
        if (!h) return reply(404, { error: "not_found", endpoint });
        const wantPost = POST_ONLY.has(endpoint);
        if (wantPost !== (req.method === "POST")) return reply(405, { error: `${endpoint} is ${wantPost ? "POST" : "GET"} only` });
        try {
          await scan();
        } catch (e) {
          ok = false;
          return reply(502, { error: "node", message: e.message });
        }
        return reply(200, h(body, url.searchParams));
      } catch (e) {
        ok = false;
        return reply(e.status || 500, { error: e.message });
      } finally {
        calls.push({ endpoint, ok, body: body ?? null, query: Object.fromEntries(url.searchParams) });
        if (calls.length > 5000) calls.shift();
        if (log) console.log(JSON.stringify({ event: "tl_listener_call", endpoint, ok }));
      }
    });
  });

  return { server, scan, derive, balancesFor, calls, config: cfg };
}

// ------------------------------------------------------------------ command line

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [portArg, nodeUrl, user, pass, configPath] = process.argv.slice(2);
  if (portArg === undefined || !nodeUrl || user === undefined || pass === undefined) {
    console.error("usage: node tl-listener-double.mjs <listen port> <bitcoind rpc url> <user> <pass> [config.json]");
    process.exit(2);
  }
  const port = Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("listen port must be 0-65535");
    process.exit(2);
  }
  const d = createListenerDouble({ nodeUrl, user, pass, config: configPath ? JSON.parse(readFileSync(configPath, "utf8")) : {} });
  d.server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ event: "listening", port: d.server.address().port })));
  const stop = () => d.server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
