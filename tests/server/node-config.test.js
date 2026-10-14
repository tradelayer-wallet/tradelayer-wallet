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
