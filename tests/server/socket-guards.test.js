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

test('the orderbook relay follows the wallet socket after the UI reconnects', async () => {
    const http = require('http');
    const { Server } = require('socket.io');
    const { io } = require('socket.io-client');
    const TOKEN = 'test-token';
    const listen = (server) => new Promise((res) => server.listen(0, '127.0.0.1', res));
    const until = async (cond) => {
        for (let i = 0; i < 300 && !cond(); i++) await sleep(10);
    };

    const fasitfyServer = {};
    const { SocketService } = loadTs(path.join(SRC, 'socket.service.ts'), { '..': { fasitfyServer } }).exports;
    const { OBSocketService } = loadTs(path.join(SRC, 'ob-sockets.service.ts'), { '..': { fasitfyServer } }).exports;
    fasitfyServer.initOBSocketConnection = (options) => {
        fasitfyServer.obSocketService?.socket.disconnect();
        fasitfyServer.obSocketService = new OBSocketService(options);
    };

    const obHttp = http.createServer();
    const obServer = new Server(obHttp);
    const fromWallet = [];
    obServer.on('connection', (socket) => socket.onAny((event) => fromWallet.push(event)));
    await listen(obHttp);

    const mainHttp = http.createServer();
    const main = new SocketService();
    fasitfyServer.mainSocketService = main;
    main.init({ server: mainHttp }, TOKEN);
    await listen(mainHttp);
    const connectWallet = () => new Promise((res, rej) => {
        const socket = io(`http://127.0.0.1:${mainHttp.address().port}`, { reconnection: false, auth: { token: TOKEN } });
        socket.on('connect', () => res(socket));
        socket.on('connect_error', rej);
    });

    const first = await connectWallet();
    first.emit('ob-sockets-connect', `http://127.0.0.1:${obHttp.address().port}`);
    await until(() => fasitfyServer.obSocketService?.socket.connected);
    first.emit('new-order', { probe: 'before-reconnect' });
    await until(() => fromWallet.includes('new-order'));
    first.disconnect();

    const second = await connectWallet();
    second.emit('new-order', { probe: 'after-reconnect' });
    second.emit('swap', { sessionId: 'x', eventName: 'BUYER:STEP4', socketId: 'b', data: 'hex' });
    await until(() => fromWallet.includes('swap'));

    try {
        assert.deepStrictEqual(fromWallet, ['new-order', 'new-order', 'swap']);
    } finally {
        second.disconnect();
        fasitfyServer.obSocketService?.socket.disconnect();
        main.io.close();
        obServer.close();
    }
});
