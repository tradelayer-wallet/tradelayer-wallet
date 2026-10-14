'use strict';

// The wallet-server's RPC boundary. The client makes the HTTP call itself (tl-rpc's own call would
// round large integers in JSON.parse), so these tests run it against a loopback HTTP server that
// returns raw JSON text. Loopback only: no external network. Runs against the real rpc-wire.ts.

const path = require('path');
const http = require('http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadTs, REPO } = require('../support/ts-loader');

const { toWireResult, WireRpcClient, parseRpcJson } = loadTs(
    path.join(REPO, 'packages', 'wallet-server', 'src', 'utils', 'rpc-wire.ts'),
).exports;

// Serves one canned response body with the given status, or never answers when body is null.
const serve = async (body, status = 200) => {
    const server = http.createServer((req, res) => {
        if (body === null) return; // never answers: exercises the timeout
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, port: server.address().port };
};
const clientFor = (port, timeout = 2000) => new WireRpcClient({
    username: 'u', password: 'p', host: '127.0.0.1', port, timeout,
});
const callWith = async (body, status) => {
    const { server, port } = await serve(body, status);
    try { return await clientFor(port).call('anymethod'); } finally { server.close(); }
};

test('an integer beyond 2^53 arrives as its exact decimal string (plain JSON.parse would round it)', async () => {
    const res = await callWith('{"result":{"balance":9007199254740993,"neg":-12345678901234567890},"error":null,"id":1}', 200);
    assert.equal(res.data.balance, '9007199254740993');
    assert.equal(res.data.neg, '-12345678901234567890');
    assert.equal(res.statusCode, 200);
    assert.doesNotThrow(() => JSON.stringify(res));
});

test('integers in the safe range, and decimals, stay numbers', async () => {
    const res = await callWith('{"result":{"n":9007199254740991,"m":-9007199254740991,"amount":0.12345678,"e":1e3,"small":0},"error":null,"id":1}', 200);
    assert.strictEqual(res.data.n, 9007199254740991);
    assert.strictEqual(res.data.m, -9007199254740991);
    assert.strictEqual(res.data.amount, 0.12345678);
    assert.strictEqual(res.data.e, 1000);
    assert.strictEqual(res.data.small, 0);
});

test('digits inside a string are never rewritten, including escaped quotes', () => {
    const text = '{"txid":"123456789012345678901234","s":"a\\"12345678901234567890\\"b","n":[98765432109876543210]}';
    const parsed = parseRpcJson(text);
    assert.equal(parsed.txid, '123456789012345678901234');
    assert.equal(parsed.s, 'a"12345678901234567890"b');
    assert.deepEqual(parsed.n, ['98765432109876543210']);
});

test('error and unauthorized responses keep the tl-rpc result shapes', async () => {
    const e = await callWith('{"result":null,"error":{"code":-5,"message":"bad address"},"id":1}', 500);
    assert.deepEqual(e, { error: 'bad address', statusCode: 500, IECode: 2, EECode: -5 });
    const u = await callWith('', 401);
    assert.deepEqual(u, { error: 'Unauthorized', statusCode: 401, IECode: 4 });
    const bad = await callWith('not json', 200);
    assert.equal(bad.IECode, 1);
    assert.equal(typeof bad.error, 'string');
});

test('a server that does not answer gives ETIMEDOUT', async () => {
    const { server, port } = await serve(null);
    try {
        const res = await clientFor(port, 50).call('anymethod');
        assert.deepEqual(res, { error: 'ETIMEDOUT' });
    } finally { server.close(); server.closeAllConnections(); }
});

test('a refused connection gives the connection error, not a throw', async () => {
    const { server, port } = await serve('{}');
    await new Promise((r) => server.close(r));
    const res = await clientFor(port).call('anymethod');
    assert.equal(typeof res.error, 'string');
});

test('toWireResult converts a bigint that reaches it: exact string outside the safe range, number inside', () => {
    const res = toWireResult({ data: { balance: 9007199254740993n, small: 12n, rows: [{ amount: 1.5 }] } });
    assert.equal(res.data.balance, '9007199254740993');
    assert.equal(res.data.small, 12);
    assert.equal(res.data.rows[0].amount, 1.5);
    assert.doesNotThrow(() => JSON.stringify(res));
});

test('toWireResult leaves strings, numbers and error fields as they are, and keeps "__proto__" an own key', () => {
    const res = toWireResult({ data: { txid: 'ab'.repeat(32), n: 3, s: '0.10000000000000000001' }, statusCode: 200 });
    assert.deepEqual(res, { data: { txid: 'ab'.repeat(32), n: 3, s: '0.10000000000000000001' }, statusCode: 200 });
    assert.deepEqual(toWireResult({ error: 'E2BIG', statusCode: 200 }), { error: 'E2BIG', statusCode: 200 });
    const data = JSON.parse('{"__proto__": {"polluted": 1}, "x": 5}');
    const out = toWireResult({ data });
    assert.ok(Object.prototype.hasOwnProperty.call(out.data, '__proto__'));
    assert.equal(Object.getPrototypeOf(out.data), Object.prototype);
    assert.equal({}.polluted, undefined);
});
