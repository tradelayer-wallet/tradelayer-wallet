'use strict';

// The local RPC route forwards only allowlisted node methods. Every method the wallet's swap
// code sends through that route must be on the list, or the swap is refused with 403 at the
// first step that uses it. Runs the real main.route.ts through Fastify inject.

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Fastify = require('fastify');
const { loadTs, REPO } = require('../support/ts-loader');

const SRC = path.join(REPO, 'packages', 'wallet-server', 'src');
const SWAPPER_DIR = path.join(REPO, 'packages', 'wallet-fe', 'src', 'app', 'utils', 'swapper');

const { mainRoutes } = loadTs(path.join(SRC, 'routes', 'main.route.ts'), {
    '../index': { fasitfyServer: { rpcClient: { call: async () => ({ data: 'ok' }) } } },
    '../services/node.service': {},
    '../services/tx-builder.service': {},
    '../utils/crypto.util': {},
}).exports;

const callRoute = async (method) => {
    const app = Fastify({ logger: false });
    app.register(mainRoutes, { prefix: '/api/' });
    const res = await app.inject({ method: 'POST', url: '/api/rpc-call', payload: { method, params: [] } });
    await app.close();
    return res.statusCode;
};

// Method names the swap code passes to its RPC client, read from the source.
const swapperRpcMethods = () => {
    const names = new Set();
    for (const file of fs.readdirSync(SWAPPER_DIR)) {
        if (!file.endsWith('.ts')) continue;
        const source = fs.readFileSync(path.join(SWAPPER_DIR, file), 'utf8');
        for (const m of source.matchAll(/\bclient\(\s*['"]([a-z_]+)['"]/g)) names.add(m[1]);
    }
    return [...names].sort();
};

test('every RPC method the swap code calls is allowed by the local route', async () => {
    const methods = swapperRpcMethods();
    assert.ok(methods.includes('decodepsbt'), 'source scan did not find the swap RPC calls');
    for (const method of methods) {
        assert.notEqual(await callRoute(method), 403, `${method} is refused by the RPC allowlist`);
    }
});

test('key export, node control and wallet import methods stay refused', async () => {
    for (const method of ['dumpprivatekey', 'dumpwallet', 'importprivkey', 'stop', 'setban']) {
        assert.equal(await callRoute(method), 403, `${method} was allowed`);
    }
});

test('a failed RPC call replies with the error message, not an empty object', async () => {
    const { mainRoutes: routes } = loadTs(path.join(SRC, 'routes', 'main.route.ts'), {
        '../index': { fasitfyServer: { rpcClient: null } },
        '../services/node.service': {},
        '../services/tx-builder.service': {},
        '../utils/crypto.util': {},
    }).exports;
    const app = Fastify({ logger: false });
    app.register(routes, { prefix: '/api/' });
    const res = await app.inject({ method: 'POST', url: '/api/rpc-call', payload: { method: 'getblockchaininfo', params: [] } });
    await app.close();
    assert.equal(res.statusCode, 500);
    assert.deepStrictEqual(res.json(), { error: 'No RPC Client initialized' });
});
