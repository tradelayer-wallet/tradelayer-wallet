// Tests for tl-listener-double.mjs against a scripted bitcoind (an in-process JSON-RPC server).
// Run: node --test scripts/tl-listener-double.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createListenerDouble, decodePayload, parseTx } from "./tl-listener-double.mjs";

const SELLER = "bcrt1qseller0000000000000000000000000000000";
const BUYER = "bcrt1qbuyer00000000000000000000000000000000";
const CHANNEL = "bcrt1q" + "c".repeat(56); // a P2WSH-length address
const b36 = (n) => n.toString(36);
const atoms36 = (coins) => BigInt(Math.round(coins * 1e8)).toString(36);
const hex = (s) => Buffer.from(s, "latin1").toString("hex");
// FE-speed's encoder.ts, character for character
const commitPayload = (propertyId, coins) => `tl${b36(4)}${b36(propertyId)},${atoms36(coins)},ref:0`;
const tradePayload = ({ p1, p2, a1, a2, colAOff, expiry = 200, colAMaker = 1 }) => `tl${b36(20)}${b36(p1)},${b36(p2)},${atoms36(a1)},${atoms36(a2)},${colAOff ? "1" : "0"},${b36(expiry)},${colAMaker}`;

let seq = 0;
const tx = ({ from, payload, to, channelIn }) => ({
  txid: (++seq).toString(16).padStart(64, "0"),
  vin: [{ txid: "f".repeat(64), vout: 0, prevout: { scriptPubKey: { address: channelIn ?? from } } }],
  vout: [
    ...(to ? [{ value: 0.0000546, scriptPubKey: { type: "witness_v0_scripthash", address: to } }] : []),
    { value: 0, scriptPubKey: { type: "nulldata", asm: `OP_RETURN ${hex(payload)}` } },
    { value: 1, scriptPubKey: { type: "witness_v0_keyhash", address: from } },
  ],
});

/** A bitcoind with a settable chain: blocks[i] = txs of height i+1, plus a mempool. */
function fakeNode() {
  const state = { blocks: [], mempool: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const { method, params } = JSON.parse(Buffer.concat(chunks).toString());
      const hashOf = (h) => `block${h}`;
      const answers = {
        getblockcount: () => state.blocks.length,
        getblockhash: ([h]) => hashOf(h),
        getblock: ([hash]) => ({ tx: state.blocks[Number(hash.slice(5)) - 1] }),
        getrawmempool: () => state.mempool.map((t) => t.txid),
        getrawtransaction: ([txid]) => state.mempool.find((t) => t.txid === txid),
      };
      const out = answers[method](params);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: out, error: null, id: "x" }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ state, server, port: server.address().port })));
}

async function setup(config) {
  const node = await fakeNode();
  const d = createListenerDouble({ nodeUrl: `http://127.0.0.1:${node.port}`, user: "u", pass: "p", config, log: false });
  await new Promise((r) => d.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${d.server.address().port}`;
  const post = async (endpoint, body) => {
    const r = await fetch(`${base}/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    return { status: r.status, body: await r.json() };
  };
  const get = async (endpoint, query = {}) => {
    const r = await fetch(`${base}/${endpoint}?${new URLSearchParams(query)}`);
    return { status: r.status, body: await r.json() };
  };
  return { node, d, post, get, close: () => { d.server.close(); node.server.close(); } };
}

const config = { balances: { "*": [{ propertyId: 1, available: 100 }, { propertyId: 5, available: 100 }] }, properties: { 1: { ticker: "TLt" }, 5: { ticker: "USDTt" } } };

test("payloads: FE-speed's commit and channel-trade strings decode, anything else does not", () => {
  const c = decodePayload(hex(commitPayload(5, 0.5)));
  assert.deepEqual({ ...c, atoms: c.atoms.toString() }, { kind: "commit", propertyId: 5, atoms: "50000000", channelRef: "ref:0" });
  const t = decodePayload(hex(tradePayload({ p1: 1, p2: 5, a1: 1, a2: 0.5, colAOff: false, colAMaker: 0 })));
  assert.equal(t.kind, "trade");
  assert.equal(t.atoms1, 100000000n);
  assert.equal(t.atoms2, 50000000n);
  assert.equal(t.columnAIsOfferer, false);
  assert.equal(decodePayload(hex("hello")), null);
  assert.equal(decodePayload("zz"), null);
  assert.equal(decodePayload(hex("tl4!,1,x")), null, "a character outside base 36 is not an amount");
  assert.equal(parseTx({ txid: "a", vout: [] }), null);
});

test("the first committer of a channel is column A and the second is column B, mempool commits count", async () => {
  const s = await setup(config);
  try {
    s.node.state.mempool.push(tx({ from: SELLER, to: CHANNEL, payload: commitPayload(5, 0.5) }));
    // the buyer asks for its column right after the seller broadcast (nothing mined yet)
    const col = await s.post("tl_getChannelColumn", { channelAddress: CHANNEL, buyerAddress: BUYER, cpAddress: SELLER });
    assert.equal(col.body, "B");
    assert.equal((await s.post("tl_getChannelColumn", { channelAddress: CHANNEL, newCommitAddress: SELLER, cpAddress: BUYER })).body, "A");
    // an unknown channel: the first committer will be A
    assert.equal((await s.post("tl_getChannelColumn", { channelAddress: "bcrt1q" + "d".repeat(56), newCommitAddress: BUYER, cpAddress: SELLER })).body, "A");
    const ch = await s.post("tl_getChannel", { params: SELLER });
    assert.deepEqual(ch.body.participants, { A: SELLER });
    assert.equal(ch.body.commits[0].confirmed, false);
    // balances move only when mined
    const before = (await s.post("tl_getAllBalancesForAddress", { params: SELLER })).body;
    assert.equal(before.find((r) => r.propertyId === "5").available, 100);
    assert.equal(before.find((r) => r.propertyId === "5").channel, 0);
    const missing = await s.post("tl_getChannelColumn", { channelAddress: CHANNEL });
    assert.equal(missing.status, 400);
  } finally { s.close(); }
});

test("two mined commits and one mined trade: balances, channel balances, history", async () => {
  const s = await setup(config);
  try {
    // seller commits 1 of property 1 (the swapper commits what it sells), buyer commits 0.5 of property 5
    s.node.state.blocks.push([tx({ from: SELLER, to: CHANNEL, payload: commitPayload(1, 1) })]);
    s.node.state.blocks.push([tx({ from: BUYER, to: CHANNEL, payload: commitPayload(5, 0.5) })]);
    let bal = (await s.post("tl_getAllBalancesForAddress", { params: SELLER })).body;
    assert.deepEqual(bal.find((r) => r.propertyId === "1"), { propertyId: "1", ticker: "TLt", amount: 100, available: 99, reserved: 0, margin: 0, vesting: 0, channel: 1 });
    bal = (await s.post("tl_getAllBalancesForAddress", { address: BUYER })).body;
    assert.equal(bal.find((r) => r.propertyId === "5").available, 99.5);
    assert.equal(bal.find((r) => r.propertyId === "5").channel, 0.5);
    const rows = (await s.get("tl_channelBalanceForCommiter", { address: SELLER, propertyId: 1 })).body;
    assert.equal(rows.total, 1);
    assert.deepEqual({ ...rows.rows[0], participants: undefined }, { channel: CHANNEL, column: "A", propertyId: 1, amount: 1, participants: undefined, counterparty: BUYER, lastCommitmentBlock: 1 });
    // the trade: column A (seller) offers 1 of p1 for 0.5 of p5
    s.node.state.blocks.push([tx({ from: BUYER, channelIn: CHANNEL, payload: tradePayload({ p1: 1, p2: 5, a1: 1, a2: 0.5, colAOff: true, colAMaker: 1 }) })]);
    const sellerBal = (await s.post("tl_getAllBalancesForAddress", { params: SELLER })).body;
    const buyerBal = (await s.post("tl_getAllBalancesForAddress", { params: BUYER })).body;
    const at = (rows, id) => rows.find((r) => r.propertyId === String(id));
    assert.equal(at(sellerBal, 1).channel, 0);
    assert.equal(at(sellerBal, 5).channel, 0.5);
    assert.equal(at(buyerBal, 1).channel, 1);
    assert.equal(at(buyerBal, 5).channel, 0);
    const hist = (await s.get("tl_tokenTradeHistoryForAddress", { propertyId1: 1, propertyId2: 5, address: BUYER })).body;
    assert.equal(hist.length, 1);
    assert.equal(hist[0].buyer, BUYER);
    assert.equal(hist[0].seller, SELLER);
    assert.equal(hist[0].price, 0.5);
    assert.equal(hist[0].amountOffered, 1);
    assert.equal(hist[0].block, 3);
    assert.equal(hist[0].txid, s.node.state.blocks[2][0].txid);
    assert.deepEqual((await s.get("tl_tokenTradeHistoryForAddress", { propertyId1: 1, propertyId2: 5, address: "bcrt1qnobody" })).body, []);
  } finally { s.close(); }
});

test("a commit above the available balance and a trade above the channel balance move nothing", async () => {
  const s = await setup(config);
  try {
    s.node.state.blocks.push([tx({ from: SELLER, to: CHANNEL, payload: commitPayload(1, 500) })]);
    s.node.state.blocks.push([tx({ from: BUYER, to: CHANNEL, payload: commitPayload(5, 0.5) })]);
    s.node.state.blocks.push([tx({ from: BUYER, channelIn: CHANNEL, payload: tradePayload({ p1: 1, p2: 5, a1: 1, a2: 0.5, colAOff: true }) })]);
    const bal = (await s.post("tl_getAllBalancesForAddress", { params: SELLER })).body;
    assert.equal(bal.find((r) => r.propertyId === "1").available, 100);
    assert.equal(bal.find((r) => r.propertyId === "1").channel, 0);
    assert.equal((await s.get("tl_tokenTradeHistoryForAddress", { propertyId1: 1, propertyId2: 5, address: BUYER })).body.length, 0);
    const state = (await s.get("__test/state")).body;
    assert.equal(state.height, 3);
  } finally { s.close(); }
});

test("a reorg that drops a block takes its effects away", async () => {
  const s = await setup(config);
  try {
    s.node.state.blocks.push([tx({ from: SELLER, to: CHANNEL, payload: commitPayload(1, 1) })]);
    assert.equal((await s.post("tl_getAllBalancesForAddress", { params: SELLER })).body.find((r) => r.propertyId === "1").channel, 1);
    s.node.state.blocks.length = 0;
    assert.equal((await s.post("tl_getAllBalancesForAddress", { params: SELLER })).body.find((r) => r.propertyId === "1").channel, 0);
  } finally { s.close(); }
});

test("flat endpoints keep the shapes wallet-fe parses", async () => {
  const s = await setup({ ...config, unattested: [BUYER] });
  try {
    assert.equal((await s.post("tl_initmain", { wallet: true })).body.initialized, true);
    s.node.state.blocks.push([], []);
    assert.equal((await s.post("tl_getMaxProcessedHeight")).body.maxProcessedHeight, 2);
    assert.equal((await s.post("tl_getSyncStatus")).body.synced, true);
    assert.equal((await s.post("tl_checkSync")).body.consensus, 2);
    const att = await s.post("tl_getAttestations", { address: SELLER, id: 0 });
    assert.equal(att.body[0].data.status, "active");
    assert.deepEqual((await s.post("tl_getAttestations", { address: BUYER, id: 0 })).body, []);
    const props = (await s.post("tl_listProperties")).body;
    assert.deepEqual(props.map((p) => p.id), [1, 5]);
    assert.equal((await s.post("tl_getProperty", { params: 5 })).body.ticker, "USDTt");
    assert.equal((await s.post("tl_getProperty", { params: -1 })).status, 400);
    assert.equal((await s.get("tl_getInitMargin", { contractId: 3, price: 10 })).body, 0.05);
    assert.equal((await s.get("tl_contractPosition", { address: SELLER, contractId: 3 })).body.position, "0");
    assert.deepEqual((await s.post("tl_getChannel", { params: SELLER })).body, { error: "No channel found" });
    assert.equal((await s.get("tl_initmain")).status, 405, "a POST endpoint refuses GET");
    assert.equal((await s.post("tl_nonsense")).status, 404);
    assert.equal((await s.post("tl_getAllBalancesForAddress", {})).status, 400);
    const calls = (await s.get("__test/calls")).body;
    assert.ok(calls.some((c) => c.endpoint === "tl_getProperty" && c.ok === false));
    const set = await s.post("__test/state", { balances: { "*": [{ propertyId: 9, available: 3 }] } });
    assert.equal(set.status, 200);
    assert.deepEqual((await s.post("tl_getAllBalancesForAddress", { params: SELLER })).body.map((r) => r.propertyId), ["9"]);
  } finally { s.close(); }
});

test("a non-loopback node URL is refused", () => {
  assert.throws(() => createListenerDouble({ nodeUrl: "http://10.0.0.1:8332", user: "u", pass: "p" }), /loopback/);
});
