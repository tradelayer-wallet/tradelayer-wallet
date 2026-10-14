'use strict';

// tl-rpc returns integers outside the JS safe range as bigint. The wallet-server must turn them
// into numbers before anything does arithmetic on them or JSON-serializes them (JSON.stringify
// throws on a bigint). Runs against the real rpc-wire.ts.

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadTs, REPO } = require('../support/ts-loader');

const { toWireResult, WireRpcClient } = loadTs(
    path.join(REPO, 'packages', 'wallet-server', 'src', 'utils', 'rpc-wire.ts'),
).exports;
const { RpcClient } = require('tl-rpc');

test('toWireResult converts nested bigint values to numbers and keeps the result serializable', () => {
    const res = toWireResult({ data: { balance: 9007199254740993n, rows: [{ amount: 12n }, { amount: 1.5 }] } });
    assert.equal(typeof res.data.balance, 'number');
    assert.equal(res.data.rows[0].amount, 12);
    assert.equal(res.data.rows[1].amount, 1.5);
    assert.doesNotThrow(() => JSON.stringify(res));
});

test('toWireResult leaves strings, numbers and error fields as they are', () => {
    const res = toWireResult({ data: { txid: 'ab'.repeat(32), n: 3, s: '0.10000000000000000001' }, statusCode: 200 });
    assert.deepEqual(res, { data: { txid: 'ab'.repeat(32), n: 3, s: '0.10000000000000000001' }, statusCode: 200 });
    const err = toWireResult({ error: 'E2BIG', statusCode: 200 });
    assert.deepEqual(err, { error: 'E2BIG', statusCode: 200 });
});

test('toWireResult keeps a "__proto__" key as an ordinary own property', () => {
    // JSON.parse makes "__proto__" an own data property, which is what a response can contain.
    const data = JSON.parse('{"__proto__": {"polluted": 1}, "x": 5}');
    const res = toWireResult({ data });
    assert.ok(Object.prototype.hasOwnProperty.call(res.data, '__proto__'));
    assert.equal(Object.getPrototypeOf(res.data), Object.prototype);
    assert.equal({}.polluted, undefined);
});

test('WireRpcClient.call returns converted results from the underlying client', async (t) => {
    const original = RpcClient.prototype.call;
    t.after(() => { RpcClient.prototype.call = original; });
    RpcClient.prototype.call = async () => ({ data: { height: 10n }, statusCode: 200 });
    const client = new WireRpcClient({ username: 'u', password: 'p', host: 'localhost', port: 1, timeout: 100 });
    const res = await client.call('getblockchaininfo');
    assert.equal(res.data.height, 10);
    assert.doesNotThrow(() => JSON.stringify(res));
});
