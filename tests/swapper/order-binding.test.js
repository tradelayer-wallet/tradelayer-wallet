'use strict';

/*
 * A swap starts only for a trade that fits an open order this wallet placed. The orderbook's new-channel
 * names the trade, this wallet's side included; before, any well-formed one started a swap on the
 * orderbook's terms (a seller with no open order broadcast a commit of 500,000 tokens at 1 sat each).
 * Offline: the socket is an in-process fake, RPC and txs are stubs, the ledger and the swappers are real.
 */
const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('events');
const { loadTs, REPO } = require('../support/ts-loader');
const fx = require('../support/psbt-fixture');

const APP = path.join(REPO, 'packages', 'wallet-fe', 'src', 'app');
const SWAPPER = path.join(APP, 'utils', 'swapper');
const { OrderLedger } = loadTs(path.join(SWAPPER, 'order-ledger.ts')).exports;

const SID = 'd4'.repeat(32);
const SELLER = { address: 'S-ADDR', pubkey: fx.SELLER_PUB };
const BUYER = { address: 'B-ADDR', pubkey: fx.BUYER_PUB };
const TOKEN = 11;
const LTC = 0;
const UNIT = 100000000;

// A trade as the orderbook builds it: the buyer's pair, amountDesired token units at `price` sats per token.
const trade = ({ amount = UNIT, price = UNIT, desired = TOKEN, forSale = LTC, buyer = BUYER, seller = SELLER, type = 'SPOT' } = {}) => ({
    type,
    buyer: { socketId: 'OB-B', keypair: buyer },
    seller: { socketId: 'OB-S', keypair: seller },
    taker: 'OB-B',
    maker: 'OB-S',
    props: { propIdDesired: desired, propIdForSale: forSale, amountDesired: amount, amountForSale: (amount * price) / UNIT, price },
});
// Orders as SpotOrdersService sends them (wire units).
const sellOrder = ({ amount = UNIT, price = UNIT, keypair = SELLER } = {}) =>
    ({ keypair, action: 'SELL', type: 'SPOT', props: { id_desired: LTC, id_for_sale: TOKEN, amount, price } });
const buyOrder = ({ amount = UNIT, price = UNIT, keypair = BUYER } = {}) =>
    ({ keypair, action: 'BUY', type: 'SPOT', props: { id_desired: TOKEN, id_for_sale: LTC, amount, price } });

test('the ledger: a trade fits only an open order of this wallet, on its side, pair, limit and amount', () => {
    const ledger = new OrderLedger();
    assert.match(ledger.reserve(trade(), false).error, /does not fit an open order/, 'no order, no swap');

    ledger.record(sellOrder({ amount: 2 * UNIT, price: UNIT }));
    assert.ok(ledger.reserve(trade({ price: UNIT - 1 }), false).error, 'a sell below its limit fitted');
    assert.ok(ledger.reserve(trade(), true).error, 'a sell order fitted this wallet as the buyer');
    assert.ok(ledger.reserve(trade({ seller: { ...SELLER, pubkey: `02${"7".repeat(64)}` } }), false).error, 'another pubkey for the address fitted');
    assert.ok(ledger.reserve(trade({ desired: 12 }), false).error, 'another token fitted');
    assert.ok(ledger.reserve(trade({ amount: 3 * UNIT }), false).error, 'more than the order fitted');
    const wrongValue = trade();
    wrongValue.props.amountForSale -= 1;
    assert.match(ledger.reserve(wrongValue, false).error, /not its amount at its price/);
    assert.match(ledger.reserve(trade({ type: 'FUTURES' }), false).error, /only spot orders/);
    assert.deepEqual(ledger.openAmounts(), [2 * UNIT], 'a refused trade reserved part of the order');

    // A sell receives at least its limit: a better price fits.
    const first = ledger.reserve(trade({ price: UNIT + 5 }), false);
    assert.ok(first.reservation, first.error);
    assert.deepEqual(ledger.openAmounts(), [UNIT]);
    const second = ledger.reserve(trade(), false);
    assert.ok(second.reservation, 'the rest of the order did not fit');
    assert.ok(ledger.reserve(trade({ amount: 1 }), false).error, 'two reserved swaps left room for a third');
    ledger.release(first.reservation);
    assert.deepEqual(ledger.openAmounts(), [UNIT], 'an aborted swap did not give its amount back');
});

test('the ledger: a buy pays at most its limit; forget and clear remove orders', () => {
    const ledger = new OrderLedger();
    ledger.record(buyOrder({ price: UNIT }));
    assert.ok(ledger.reserve(trade({ price: UNIT + 1 }), true).error, 'a buy above its limit fitted');
    assert.ok(ledger.reserve(trade({ price: UNIT }), true).reservation);
    ledger.record(buyOrder({ price: 2 * UNIT }));
    ledger.forget(buyOrder({ price: 2 * UNIT }));
    assert.ok(ledger.reserve(trade({ price: 2 * UNIT }), true).error, 'a forgotten order still fitted');
    ledger.record(buyOrder());
    ledger.clear();
    assert.deepEqual(ledger.openAmounts(), []);
    ledger.record({ ...buyOrder(), type: 'FUTURES' });
    ledger.record(buyOrder({ amount: 0.5 }));
    assert.deepEqual(ledger.openAmounts(), [], 'a futures order or one in non-integer units was recorded');
});

// ---- SwapService, with the real ledger and swappers ----------------------------------

class FakeSocket extends EventEmitter {
    constructor() { super(); this.sent = []; }
    emit(ev, ...args) {
        if (ev === 'swap') { this.sent.push(args[0]); return true; }
        return super.emit(ev, ...args);
    }
    deliver(ev, ...args) { return super.emit(ev, ...args); }
}

const loadSwapService = () => {
    class Stub {}
    const swapperIndex = loadTs(path.join(SWAPPER, 'index.ts')).exports;
    const protocol = loadTs(path.join(SWAPPER, 'protocol.ts')).exports;
    const common = loadTs(path.join(SWAPPER, 'common.ts')).exports;
    const ledgerModule = loadTs(path.join(SWAPPER, 'order-ledger.ts')).exports;
    const stubs = {
        '@angular/core': { Injectable: () => () => {} },
        'ngx-toastr': { ToastrService: Stub },
        './rpc.service': { RpcService: Stub },
        './socket.service': { obEventPrefix: 'OB_SOCKET', SocketService: Stub },
        './txs.service': { TxsService: Stub },
        './loading.service': { LoadingService: Stub },
        './sound.service': { ESounds: { TRADE_COMPLETED: 'done' }, SoundsService: Stub },
        'src/app/utils/swapper': swapperIndex,
        'src/app/utils/swapper/protocol': protocol,
        'src/app/utils/swapper/common': common,
        'src/app/utils/swapper/order-ledger': ledgerModule,
    };
    const { SwapService } = loadTs(path.join(APP, '@core', 'services', 'swap.service.ts'), stubs).exports;
    const { OrderLedgerService } = loadTs(path.join(APP, '@core', 'services', 'order-ledger.service.ts'), stubs).exports;
    return { SwapService, OrderLedgerService };
};

const makeService = () => {
    const { SwapService, OrderLedgerService } = loadSwapService();
    const socket = new FakeSocket();
    const rpcCalls = [];
    const errors = [];
    const ledger = new OrderLedgerService();
    const service = new SwapService(
        { socket },
        // The node refuses everything: a started swap aborts at its first RPC, which the tests watch for.
        { rpc: async (method) => { rpcCalls.push(method); return { error: 'stubbed node' }; } },
        { ownsKeyPair: () => true, getWifByAddress: () => 'WIF' },
        { error: (m) => errors.push(m), info: () => {}, warning: () => {} },
        { tradesLoading: false },
        { playSound: () => {} },
        ledger,
    );
    service.onInit();
    return { service, socket, rpcCalls, errors, ledger };
};

const settleTick = () => new Promise((res) => setTimeout(res, 300));

test('SwapService refuses a new-channel for no order of this wallet, at once and with no RPC', async () => {
    const { socket, rpcCalls, errors } = makeService();
    socket.deliver('OB_SOCKET::new-channel', { sessionId: SID, isBuyer: false, tradeInfo: trade({ amount: 500000 * UNIT, price: 1 }) });
    await settleTick();
    assert.deepEqual(rpcCalls, [], `an unsolicited offer reached the node: ${rpcCalls.join(', ')}`);
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0].eventName, 'TERMINATE_TRADE');
    assert.equal(socket.sent[0].sessionId, SID);
    assert.match(socket.sent[0].data, /does not fit an open order this wallet placed/);
    assert.match(errors[0], /Swap offer refused/);
});

test('SwapService starts the swap for an order of this wallet, and an aborted swap gives the amount back', async () => {
    const { socket, rpcCalls, ledger } = makeService();
    ledger.record(sellOrder({ amount: UNIT, price: UNIT }));
    socket.deliver('OB_SOCKET::new-channel', { sessionId: SID, isBuyer: false, tradeInfo: trade() });
    for (let i = 0; i < 50 && !rpcCalls.includes('addmultisigaddress'); i++) await settleTick();
    assert.ok(rpcCalls.includes('addmultisigaddress'), 'the swap for the wallet\'s own order did not start');
    for (let i = 0; i < 50 && ledger.openAmounts()[0] !== UNIT; i++) await settleTick();
    assert.deepEqual(ledger.openAmounts(), [UNIT], 'the aborted swap kept its reservation');
});

test('SwapService forgets this wallet\'s orders when the orderbook connection drops', async () => {
    const { socket, rpcCalls, ledger } = makeService();
    ledger.record(sellOrder());
    socket.deliver('OB_SOCKET::disconnect');
    socket.deliver('OB_SOCKET::new-channel', { sessionId: SID, isBuyer: false, tradeInfo: trade() });
    await settleTick();
    assert.deepEqual(rpcCalls, [], 'a swap started for an order the orderbook had dropped');
    assert.equal(socket.sent[0].eventName, 'TERMINATE_TRADE');
});
