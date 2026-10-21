'use strict';

/*
 * A swap trades only from a key pair this wallet holds. The orderbook supplies the trade, including this
 * wallet's own side: an address the wallet holds, paired with someone else's pubkey, made the seller build
 * the 2-of-2 from two foreign keys (addmultisigaddress) and broadcast its commit into it, and made the buyer
 * accept that channel. Each side now refuses before it builds the channel, with nothing built, signed or sent.
 * Offline: the socket is an in-process fake, RPC and txs are stubs.
 */
const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('events');
const { loadTs, REPO } = require('../support/ts-loader');
const fx = require('../support/psbt-fixture');

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const settle = (sw, ms = 8000) => Promise.race([
    sw.ready,
    sleep(ms).then(() => { throw new Error(`swap did not settle within ${ms} ms`); }),
]);

const SWAP_EVENT = 'swap';
const APP = path.join(REPO, 'packages', 'wallet-fe', 'src', 'app');
const freshRequire = (rel) => loadTs(path.join(APP, 'utils', rel.replace(/\.js$/, '.ts'))).exports;

class FakeSocket extends EventEmitter {
    constructor() { super(); this.sent = []; }
    emit(ev, ...args) {
        if (ev === SWAP_EVENT) { this.sent.push(args[0]); return true; }
        return super.emit(ev, ...args);
    }
    deliver(ev, ...args) { return super.emit(ev, ...args); }
}

const SID = 'a'.repeat(64);
const ATTACKER_PUB = `02${'7'.repeat(64)}`;
const sellerParty = { keypair: { address: 'S-ADDR', pubkey: fx.SELLER_PUB }, socketId: 'OB-S' };
const buyerParty = { keypair: { address: 'B-ADDR', pubkey: fx.BUYER_PUB }, socketId: 'OB-B' };
const spotProps = { propIdDesired: 11, amountDesired: 100000000, propIdForSale: 0, amountForSale: 100000000, price: 100000000 };

// Every RPC is recorded; the swap must not reach any of them.
const recordingNode = (calls) => async (method) => {
    calls.push(method);
    if (method === 'addmultisigaddress') return { data: { address: 'MS-ADDR', redeemScript: fx.REDEEM } };
    return { error: `unstubbed rpc ${method}` };
};
const txsOwning = (owned, calls) => ({
    getWifByAddress: () => 'WIF',
    ownsKeyPair: (address, pubkey) => owned.some((k) => k.address === address && k.pubkey === pubkey),
    buildTx: async () => { calls.push('buildTx'); return { error: 'not expected' }; },
    signTx: async () => { calls.push('signTx'); return { error: 'not expected' }; },
    sendTx: async () => { calls.push('sendTx'); return { error: 'not expected' }; },
});

test('AuthService.ownsKeyPair holds only for an address with its very pubkey', () => {
    class Stub {}
    const { AuthService } = loadTs(path.join(APP, '@core', 'services', 'auth.service.ts'), {
        '@angular/compiler': {}, '@angular/core': { Injectable: () => () => {} }, '@angular/router': { Router: Stub },
        'ngx-toastr': { ToastrService: Stub }, rxjs: { Subject: Stub }, '../../utils/crypto.util': {},
        './api.service': { ApiService: Stub }, './dialogs.service': { DialogService: Stub },
        './rpc.service': { RpcService: Stub }, './windows.service': { WindowsService: Stub },
    }).exports;
    const wallet = { listOfallAddresses: [{ address: 'S-ADDR', pubkey: fx.SELLER_PUB.toLowerCase(), wif: 'WIF' }] };
    const owns = (address, pubkey) => AuthService.prototype.ownsKeyPair.call(wallet, address, pubkey);
    assert.equal(owns('S-ADDR', fx.SELLER_PUB), true);
    assert.equal(owns('S-ADDR', fx.SELLER_PUB.toUpperCase()), true, 'hex case does not matter');
    assert.equal(owns('S-ADDR', ATTACKER_PUB), false, 'an address the wallet holds with another pubkey is not owned');
    assert.equal(owns('OTHER', fx.SELLER_PUB), false, 'the pubkey under an address the wallet does not hold is not owned');
    assert.equal(owns('S-ADDR', ''), false);
    assert.equal(owns('S-ADDR', undefined), false);
    assert.equal(AuthService.prototype.ownsKeyPair.call({ listOfallAddresses: undefined }, 'S-ADDR', fx.SELLER_PUB), false);
});

test('TxsService.ownsKeyPair asks AuthService', () => {
    class Stub {}
    const { TxsService } = loadTs(path.join(APP, '@core', 'services', 'txs.service.ts'), {
        '@angular/core': { Injectable: () => () => {} }, 'ngx-toastr': { ToastrService: Stub },
        './api.service': { ApiService: Stub }, './auth.service': { AuthService: Stub }, './balance.service': { BalanceService: Stub },
        './loading.service': { LoadingService: Stub }, './rpc.service': { RpcService: Stub },
    }).exports;
    const asked = [];
    const auth = { ownsKeyPair: (address, pubkey) => { asked.push([address, pubkey]); return address === 'S-ADDR'; } };
    const txs = new TxsService(null, null, auth, null, null, null);
    assert.equal(txs.ownsKeyPair('S-ADDR', fx.SELLER_PUB), true);
    assert.equal(txs.ownsKeyPair('B-ADDR', fx.BUYER_PUB), false);
    assert.deepEqual(asked, [['S-ADDR', fx.SELLER_PUB], ['B-ADDR', fx.BUYER_PUB]]);
});

test('a seller whose side names a foreign pubkey refuses before it builds the channel or commits', async () => {
    const { SellSwapper } = freshRequire('swapper/index.js');
    const { ETradeType } = freshRequire('swapper/common.js');
    const sock = new FakeSocket();
    const calls = [];
    // The wallet holds S-ADDR with its own pubkey; the trade names S-ADDR with the attacker's.
    const mine = [{ address: 'S-ADDR', pubkey: fx.SELLER_PUB }];
    const foreignSeller = { ...sellerParty, keypair: { address: 'S-ADDR', pubkey: ATTACKER_PUB } };
    const sw = new SellSwapper(SID, ETradeType.SPOT, spotProps, foreignSeller, buyerParty, recordingNode(calls), sock, txsOwning(mine, calls));
    const res = await settle(sw);
    assert.equal(res.status, 'aborted');
    assert.match(res.reason, /InitTrade: the trade names a key pair this wallet does not hold for S-ADDR/);
    assert.deepEqual(calls, [], `the refused seller reached ${calls.join(', ')}`);
    assert.deepEqual(sock.sent.map((e) => e.eventName), ['TERMINATE_TRADE'], 'the refused seller sent something other than TERMINATE_TRADE');
});

test('a seller trading from its own key pair still builds the channel', async () => {
    const { SellSwapper } = freshRequire('swapper/index.js');
    const { ETradeType } = freshRequire('swapper/common.js');
    const sock = new FakeSocket();
    const calls = [];
    const sw = new SellSwapper(SID, ETradeType.SPOT, spotProps, sellerParty, buyerParty, recordingNode(calls), sock, txsOwning([sellerParty.keypair], calls));
    for (let i = 0; i < 100 && !calls.includes('addmultisigaddress'); i++) await sleep(10);
    assert.ok(calls.includes('addmultisigaddress'), 'an honest seller did not build the channel');
    sw.terminateTrade('test done');
});

test('a buyer whose side names a foreign pubkey refuses SELLER:STEP1 before it checks or joins the channel', async () => {
    const { BuySwapper } = freshRequire('swapper/index.js');
    const { ETradeType } = freshRequire('swapper/common.js');
    const sock = new FakeSocket();
    const calls = [];
    const mine = [{ address: 'B-ADDR', pubkey: fx.BUYER_PUB }];
    const foreignBuyer = { ...buyerParty, keypair: { address: 'B-ADDR', pubkey: ATTACKER_PUB } };
    const sw = new BuySwapper(SID, ETradeType.SPOT, spotProps, foreignBuyer, sellerParty, recordingNode(calls), sock, txsOwning(mine, calls));
    sock.deliver(SWAP_EVENT, { sessionId: SID, eventName: 'SELLER:STEP1', socketId: 'OB-S', data: { address: 'MS-ADDR', redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.MS } });
    const res = await settle(sw);
    assert.equal(res.status, 'aborted');
    assert.match(res.reason, /Step 1: the trade names a key pair this wallet does not hold for B-ADDR/);
    assert.deepEqual(calls, [], `the refused buyer reached ${calls.join(', ')}`);
    assert.deepEqual(sock.sent.map((e) => e.eventName), ['TERMINATE_TRADE'], 'the refused buyer sent BUYER:STEP2 or more');
});
