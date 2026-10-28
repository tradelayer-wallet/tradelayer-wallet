'use strict';

// litecoin.conf holds the RPC password. The file must be created readable and writable by its
// owner only (POSIX mode 0600). Runs against the real node.service.ts, in a fresh temp directory
// that the test removes afterwards.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadTs, REPO } = require('../support/ts-loader');

// node.service imports the fastify server singleton from '..'. The config writer does not use it.
const { createConfigFile } = loadTs(
    path.join(REPO, 'packages', 'wallet-server', 'src', 'services', 'node.service.ts'),
    { '..': { fasitfyServer: {} } },
).exports;

test('createConfigFile writes litecoin.conf with owner-only permissions', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-wallet-conf-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const res = await createConfigFile({ username: 'u', password: 'p4ss', port: 9332, path: dir });
    assert.equal(res.error, undefined);
    const file = path.join(dir, 'litecoin.conf');
    assert.match(fs.readFileSync(file, 'utf8'), /rpcpassword=p4ss/);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
});

test('createConfigFile does not overwrite an existing litecoin.conf', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-wallet-conf-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'litecoin.conf');
    fs.writeFileSync(file, 'rpcuser=keep\n');
    const res = await createConfigFile({ username: 'u', password: 'p', port: 9332, path: dir });
    assert.ok(res.error);
    assert.equal(fs.readFileSync(file, 'utf8'), 'rpcuser=keep\n');
});

// Start-up against a stubbed RPC client. The node is "started" only when it answers with a result.
// The stub replies come from `reply`, set per test.
let reply = () => ({});
const rpcCalls = [];
class FakeWireRpcClient {
    constructor(options) { this.options = options; }
    async call(method) { rpcCalls.push({ method, options: this.options }); return reply(this.options); }
}
const fasitfyServer = { rpcClient: null, rpcPort: null, mainSocketService: { startBlockCounting() {} } };
const startNode = loadTs(
    path.join(REPO, 'packages', 'wallet-server', 'src', 'services', 'node.service.ts'),
    { '..': { fasitfyServer }, '../utils/rpc-wire': { WireRpcClient: FakeWireRpcClient } },
).exports.startWalletNode;

const withConf = (t, conf) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-wallet-start-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'litecoin.conf'), conf);
    return dir;
};
const resetStart = () => {
    rpcCalls.length = 0;
    fasitfyServer.rpcClient = null;
    fasitfyServer.rpcPort = null;
};
// Makes the retry wait immediate, for the retry tests only.
const immediateTimers = (t) => {
    const real = global.setTimeout;
    global.setTimeout = (fn) => real(fn, 0);
    t.after(() => { global.setTimeout = real; });
};
const STARTED = { data: { blocks: 1, headers: 1 } };

test('a password containing "=" is read whole from litecoin.conf', async (t) => {
    resetStart();
    const dir = withConf(t, 'rpcuser=u\nrpcpassword=pa=ss==\nrpcport=9332\n');
    reply = () => STARTED;
    const res = await startNode({ testnet: false, datadir: dir });
    assert.equal(res.data, true);
    assert.equal(rpcCalls[0].options.password, 'pa=ss==');
});

test('without rpcport the Litecoin default RPC port is used (9332, testnet 19332)', async (t) => {
    const dir = withConf(t, 'rpcuser=u\nrpcpassword=p\n');
    resetStart();
    reply = () => STARTED;
    await startNode({ testnet: false, datadir: dir });
    assert.equal(rpcCalls[0].options.port, 9332);
    resetStart();
    await startNode({ testnet: true, datadir: dir });
    assert.equal(rpcCalls[0].options.port, 19332);
});

test('wrong RPC credentials are reported as an error, not as a started node', async (t) => {
    const dir = withConf(t, 'rpcuser=u\nrpcpassword=p\n');
    resetStart();
    reply = () => ({ error: 'Unauthorized', statusCode: 401, IECode: 4 });
    const res = await startNode({ testnet: false, datadir: dir });
    assert.equal(res.error, 'Unauthorized');
    assert.equal(fasitfyServer.rpcClient, null);
});

test('a node that is still starting is waited for', { timeout: 10000 }, async (t) => {
    immediateTimers(t);
    const dir = withConf(t, 'rpcuser=u\nrpcpassword=p\n');
    resetStart();
    const answers = [
        { error: 'connect ECONNREFUSED 127.0.0.1:9332' },
        { error: 'Loading block index...', statusCode: 500, EECode: -28, IECode: 2 },
        STARTED,
    ];
    reply = () => answers.shift();
    const res = await startNode({ testnet: false, datadir: dir });
    assert.equal(res.data, true);
    assert.equal(rpcCalls.length, 3);
});

test('a node that never starts ends the start with an error after a bounded wait', { timeout: 10000 }, async (t) => {
    immediateTimers(t);
    const dir = withConf(t, 'rpcuser=u\nrpcpassword=p\n');
    resetStart();
    reply = () => ({ error: 'connect ECONNREFUSED 127.0.0.1:9332' });
    const res = await startNode({ testnet: false, datadir: dir });
    assert.match(res.error, /ECONNREFUSED/);
    assert.ok(rpcCalls.length > 1 && rpcCalls.length <= 300, `attempts: ${rpcCalls.length}`);
    assert.equal(fasitfyServer.rpcClient, null);
});

test('createConfigFile refuses a username or password with a line break', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-wallet-conf-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { createConfigFile } = loadTs(
        path.join(REPO, 'packages', 'wallet-server', 'src', 'services', 'node.service.ts'),
        { '..': { fasitfyServer: {} }, '../utils/rpc-wire': { WireRpcClient: FakeWireRpcClient } },
    ).exports;
    const res = await createConfigFile({ username: 'u', password: 'a\nrpcallowip=0.0.0.0/0', port: 9332, path: dir });
    assert.ok(res.error, 'a password with a line break was written');
    assert.equal(fs.existsSync(path.join(dir, 'litecoin.conf')), false);
});
