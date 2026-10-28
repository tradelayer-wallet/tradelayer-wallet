'use strict';

// Stopping the node. The stop request's result decides whether the connection is dropped, and a
// missing connection is not an error. Runs against the real node.service.ts with a stubbed RPC client.

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadTs, REPO } = require('../support/ts-loader');

let stop = async () => ({ data: 'stopping' });
const calls = [];
const fasitfyServer = {
    rpcClient: null,
    rpcPort: null,
    mainSocketService: { stopBlockCounting() { calls.push('stopBlockCounting'); } },
};
const { stopWalletNode } = loadTs(
    path.join(REPO, 'packages', 'wallet-server', 'src', 'services', 'node.service.ts'),
    { '..': { fasitfyServer }, '../utils/rpc-wire': { WireRpcClient: class {} } },
).exports;

const connect = () => {
    calls.length = 0;
    fasitfyServer.rpcPort = 9332;
    fasitfyServer.rpcClient = { call: async (method) => { calls.push(method); return stop(); } };
};

test('a stop the node accepts drops the connection and stops block counting', async () => {
    connect();
    stop = async () => ({ data: 'stopping' });
    assert.deepStrictEqual(await stopWalletNode(), { data: true });
    assert.deepStrictEqual(calls, ['stop', 'stopBlockCounting']);
    assert.equal(fasitfyServer.rpcClient, null);
    assert.equal(fasitfyServer.rpcPort, null);
});

test('a stop that fails keeps the connection and reports the error', async () => {
    connect();
    stop = async () => ({ error: 'Unauthorized', statusCode: 401, IECode: 4 });
    assert.deepStrictEqual(await stopWalletNode(), { error: 'Unauthorized' });
    assert.deepStrictEqual(calls, ['stop']);
    assert.ok(fasitfyServer.rpcClient, 'connection dropped after a failed stop');
    assert.equal(fasitfyServer.rpcPort, 9332);
});

test('a node that is already down counts as stopped', async () => {
    connect();
    stop = async () => ({ error: 'connect ECONNREFUSED 127.0.0.1:9332' });
    assert.deepStrictEqual(await stopWalletNode(), { data: true });
    assert.equal(fasitfyServer.rpcClient, null);
});

test('stopping with no connection is a no-op, not an error', async () => {
    calls.length = 0;
    fasitfyServer.rpcClient = null;
    fasitfyServer.rpcPort = null;
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
        assert.deepStrictEqual(await stopWalletNode(), { data: true });
        await new Promise((res) => setTimeout(res, 20));
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    assert.deepStrictEqual(unhandled, []);
    assert.deepStrictEqual(calls, ['stopBlockCounting']);
});
