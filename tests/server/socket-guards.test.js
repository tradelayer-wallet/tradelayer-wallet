'use strict';

// Socket paths that run without a connected wallet. Block counting starts when the node answers,
// which can be before the wallet connects, and the orderbook relay can outlive the wallet socket.
// Neither may throw: a throw in a timer or an event handler is an unhandled error in the process.

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('events');
const { loadTs, REPO } = require('../support/ts-loader');

const SRC = path.join(REPO, 'packages', 'wallet-server', 'src', 'services');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const captureUnhandled = () => {
    const seen = [];
    const onUnhandled = (error) => seen.push(error);
    process.on('unhandledRejection', onUnhandled);
    return { seen, stop: () => process.off('unhandledRejection', onUnhandled) };
};

test('block counting with no wallet socket connected records the height and throws nothing', async () => {
    const fasitfyServer = { rpcClient: { call: async () => ({ data: { blocks: 5, headers: 5 } }) } };
    const { SocketService } = loadTs(path.join(SRC, 'socket.service.ts'), {
        '..': { fasitfyServer },
        'socket.io': { Server: class {} },
    }).exports;
    const svc = new SocketService();
    const unhandled = captureUnhandled();
    let lastBlock;
    try {
        svc.startBlockCounting(5);
        await sleep(40);
        lastBlock = svc.lastBlock;
    } finally {
        svc.stopBlockCounting();
        unhandled.stop();
    }
    assert.deepStrictEqual(unhandled.seen, []);
    assert.equal(lastBlock, 5);
});

test('the orderbook relay drops events while the wallet socket is gone', () => {
    const obSocket = new EventEmitter();
    obSocket.disconnect = () => {};
    const fakeIo = () => obSocket;
    const fasitfyServer = { mainSocketService: null };
    const { OBSocketService } = loadTs(path.join(SRC, 'ob-sockets.service.ts'), {
        'socket.io-client': { io: fakeIo },
        '..': { fasitfyServer },
    }).exports;
    new OBSocketService({ url: 'http://ob.example' });
    obSocket.emit('connect');
    assert.doesNotThrow(() => obSocket.emit('order:saved', { id: 1 }));
    assert.doesNotThrow(() => obSocket.emit('swap', { sessionId: 'x' }));
});
