'use strict';

// Protocol v2 on the wallet (rounds/r12/protocol-v2.md): every inbound message is checked once at the
// boundary (protocol.ts), and the swap has three outcomes, a point of no return and bounded timers.

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('events');
const { loadTs, REPO } = require('../support/ts-loader');
const fx = require('../support/psbt-fixture');

const UTILS_DIR = path.join(REPO, 'packages', 'wallet-fe', 'src', 'app', 'utils');
const SWAPPER_DIR = path.join(UTILS_DIR, 'swapper');
const protocol = loadTs(path.join(SWAPPER_DIR, 'protocol.ts')).exports;
const freshRequire = (rel) => loadTs(path.join(UTILS_DIR, rel)).exports;

const SID = 'c3'.repeat(32);
const TXID = 'ab'.repeat(32);
const hx = fx.psbtHex;
// Waits on setImmediate, not setTimeout, so the mocked timers of the timer tests never stall the helpers.
const sleep = (ms) => new Promise((res) => {
    const end = Date.now() + ms;
    const step = () => (Date.now() >= end ? res() : setImmediate(step));
    setImmediate(step);
});

const tradeWire = (over = {}) => ({
    type: 'SPOT',
    buyer: { socketId: 'OB-B', keypair: { address: 'B-ADDR', pubkey: fx.BUYER_PUB } },
    seller: { socketId: 'OB-S', keypair: { address: 'S-ADDR', pubkey: fx.SELLER_PUB } },
    taker: 'OB-B',
    maker: 'OB-S',
    props: { propIdDesired: 11, propIdForSale: 2, amountDesired: 100000000, amountForSale: 100000000, price: 100000000 },
    ...over,
});

// ---- the boundary: one parser per message ---------------------------------------

test('new-channel: a well-formed offer is accepted and typed', () => {
    const res = protocol.parseNewChannel({ sessionId: SID, isBuyer: true, tradeInfo: tradeWire() });
    assert.ok(res.data, res.error);
    assert.equal(res.data.tradeInfo.props.amountDesired, 100000000);
});

test('new-channel: a float amount, a missing field, or a value that is not amount times price is refused', () => {
    const float = tradeWire({ props: { propIdDesired: 11, propIdForSale: 2, amountDesired: 0.5, amountForSale: 50000000, price: 100000000 } });
    assert.match(protocol.parseNewChannel({ sessionId: SID, isBuyer: true, tradeInfo: float }).error, /does not match its schema/);
    const noPrice = tradeWire({ props: { propIdDesired: 11, propIdForSale: 2, amountDesired: 100000000, amountForSale: 100000000 } });
    assert.ok(protocol.parseNewChannel({ sessionId: SID, isBuyer: true, tradeInfo: noPrice }).error);
    const wrongValue = tradeWire({ props: { propIdDesired: 11, propIdForSale: 2, amountDesired: 100000000, amountForSale: 1, price: 100000000 } });
    assert.match(protocol.parseNewChannel({ sessionId: SID, isBuyer: true, tradeInfo: wrongValue }).error, /value does not equal amount times price/);
    assert.ok(protocol.parseNewChannel({ sessionId: 'AB'.repeat(32), isBuyer: true, tradeInfo: tradeWire() }).error);
});

test('swap relay: an unknown eventName, a step from the server with a socket id, and an oversized reason are refused', () => {
    assert.ok(protocol.parseSwapRelay({ sessionId: SID, eventName: 'PING', socketId: 'OB-S', data: null }).error);
    assert.ok(protocol.parseSwapRelay({ sessionId: SID, eventName: 'SELLER:STEP1', socketId: null, data: null }).error);
    assert.ok(protocol.parseSwapRelay({ sessionId: SID, eventName: 'TERMINATE_TRADE', socketId: 'OB-S', data: 'r'.repeat(257) }).error);
    const ok = protocol.parseSwapRelay({ sessionId: SID, eventName: 'TERMINATE_TRADE', socketId: 'OB-S', data: 'r'.repeat(256) });
    assert.equal(ok.data.data.length, 256);
});

test('SELLER:STEP3: the commit output is satoshis; an LTC float amount is refused', () => {
    const utxo = { txid: TXID, vout: 0, scriptPubKey: 'aa'.repeat(34), redeemScript: 'bb'.repeat(40) };
    assert.ok(protocol.parseSwapRelay({ sessionId: SID, eventName: 'SELLER:STEP3', socketId: 'OB-S', data: { ...utxo, sats: 200000000 } }).data);
    assert.ok(protocol.parseSwapRelay({ sessionId: SID, eventName: 'SELLER:STEP3', socketId: 'OB-S', data: { ...utxo, amount: 2 } }).error);
});

test('BUYER:STEP6: the txid must be lowercase; an upper-case form is refused, not normalised', () => {
    assert.ok(protocol.parseSwapRelay({ sessionId: SID, eventName: 'BUYER:STEP6', socketId: 'OB-B', data: TXID }).data);
    assert.ok(protocol.parseSwapRelay({ sessionId: SID, eventName: 'BUYER:STEP6', socketId: 'OB-B', data: TXID.toUpperCase() }).error);
});

test('SERVER:STATE: the three terminal states, with a txid only for settled', () => {
    const state = (data) => protocol.parseSwapRelay({ sessionId: SID, eventName: 'SERVER:STATE', socketId: null, data });
    assert.deepEqual(state({ state: 'settled', txid: TXID }).data.data, { state: 'settled', txid: TXID });
    assert.deepEqual(state({ state: 'expired-unverified', txid: null }).data.data, { state: 'expired-unverified', txid: null });
    assert.ok(state({ state: 'pending', txid: null }).error);
});

test('orderbook-data: wire amounts are integer units; the display form is the number a person typed', () => {
    const order = {
        type: 'SPOT', action: 'SELL', isLimitOrder: true, marketName: 'TL/LTC',
        keypair: { address: 'a', pubkey: 'p' },
        props: { id_for_sale: 2, id_desired: 1, amount: 50000000, price: 30000000 },
        uuid: 'u1', timestamp: 1700000000000, socket_id: 'OB-S', lock: false,
    };
    const parsed = protocol.parseOrderbookData({ orders: [order], history: [] });
    assert.ok(parsed.data, parsed.error);
    const shown = protocol.toDisplayOrder(parsed.data.orders[0]);
    assert.equal(shown.props.amount, 0.5);
    assert.equal(shown.props.price, 0.3);
    const floated = { ...order, props: { ...order.props, amount: 0.5 } };
    assert.ok(protocol.parseOrderbookData({ orders: [floated], history: [] }).error, 'a float amount on the book was accepted');
});

// ---- the swap: three outcomes, a point of no return, bounded timers --------------

class FakeSocket extends EventEmitter {
    constructor() { super(); this.sent = []; }
    emit(ev, ...args) {
        if (ev === 'swap') { this.sent.push(args[0]); return true; }
        return super.emit(ev, ...args);
    }
    deliver(eventName, data = null, socketId = 'OB-S') {
        return super.emit('swap', { sessionId: SID, eventName, socketId, data });
    }
    serverState(state, txid = null) {
        return super.emit('swap', { sessionId: SID, eventName: 'SERVER:STATE', socketId: null, data: { state, txid } });
    }
}
const sentNames = (sock) => sock.sent.map((e) => e.eventName);

const buyerParty = { keypair: { address: 'B-ADDR', pubkey: fx.BUYER_PUB }, socketId: 'OB-B' };
const sellerParty = { keypair: { address: 'S-ADDR', pubkey: fx.SELLER_PUB }, socketId: 'OB-S' };
const spotProps = { propIdDesired: 11, amountDesired: 100000000, propIdForSale: 0, amountForSale: 100000000, price: 100000000 };
const COMMIT = { txid: fx.COMMIT_TXID, vout: 0, sats: 200000000, scriptPubKey: fx.SPK.MS_PSBT, redeemScript: fx.REDEEM };

// Node and transaction stubs for a buyer that reaches BUYER:STEP4 and then the signed step.
const makeBuyerDeps = (opts = {}) => {
    const calls = { sendTx: [], rpc: [] };
    const psbt = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC }));
    const node = async (method, params = []) => {
        calls.rpc.push(method);
        switch (method) {
            case 'addmultisigaddress': return { data: { address: 'MS-ADDR', redeemScript: fx.REDEEM } };
            case 'validateaddress': return { data: { isvalid: true, scriptPubKey: fx.SPK.MS } };
            case 'tl_getinfo': return { data: { block: fx.TIP } };
            case 'tl_createpayload_commit_tochannel': return { data: 'PAY-COMMIT' };
            case 'tl_createpayload_instant_ltc_trade': return { data: 'PAY-TRADE' };
            case 'decoderawtransaction': return { data: { vout: [{ value: 2, n: 0, scriptPubKey: { addresses: ['MS-ADDR'], hex: fx.SPK.MS } }] } };
            case 'decodepsbt': return fx.hexOfNodeArg(params[0]) === hx('PSBT-B') ? { data: psbt } : { error: 'TX decode failed' };
            case 'getrawtransaction': return opts.onChain ? { data: { txid: fx.TXID } } : { error: 'No such mempool transaction' };
            default: return { error: `unstubbed rpc ${method}` };
        }
    };
    const txs = {
        getWifByAddress: () => 'WIF',
        ownsKeyPair: () => true,
        buildTx: async () => ({ data: { inputs: [], rawtx: 'RAW-COMMIT' } }),
        signTx: async () => ({ data: { isValid: true, signedHex: 'SIGNED-COMMIT' } }),
        sendTx: async (hex) => {
            calls.sendTx.push(hex);
            if (hex === 'FINAL-HEX') return opts.sendFails ? { error: 'rejected' } : { data: fx.TXID };
            return { data: fx.COMMIT_TXID };
        },
        buildLTCITTx: async () => ({ data: { psbtHex: hx('PSBT-B') } }),
        signPsbt: async () => ({ data: { psbtHex: hx('PSBT-B'), isFinished: true, finalHex: 'FINAL-HEX' } }),
    };
    return { node, txs, calls };
};

// A buyer driven to the signed step: the seller's signature has arrived and the buyer has its txid.
const buyerAtSigned = async (opts = {}) => {
    const { BuySwapper } = freshRequire('swapper/index.ts');
    const { ETradeType } = freshRequire('swapper/common.ts');
    const sock = new FakeSocket();
    const deps = makeBuyerDeps(opts);
    const sw = new BuySwapper(SID, ETradeType.SPOT, spotProps, buyerParty, sellerParty, deps.node, sock, deps.txs);
    sock.deliver('SELLER:STEP1', { address: 'MS-ADDR', redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.MS }, 'OB-S');
    await waitFor(() => sentNames(sock).includes('BUYER:STEP2'));
    sock.deliver('SELLER:STEP3', COMMIT, 'OB-S');
    await waitFor(() => sentNames(sock).includes('BUYER:STEP4'));
    sock.deliver('SELLER:STEP5', hx('PSBT-B'), 'OB-S');
    return { sw, sock, deps };
};

const waitFor = async (fn, timeout = 2000) => {
    const start = Date.now();
    while (!fn()) {
        if (Date.now() - start > timeout) throw new Error('waitFor timed out');
        await sleep(1);
    }
};

test('buyer: the orderbook settles the trade, the result is settled with the txid', async (t) => {
    const { sw, sock } = await buyerAtSigned();
    await waitFor(() => sentNames(sock).includes('BUYER:STEP6'));
    sock.serverState('settled', TXID);
    assert.deepEqual(await sw.ready, { status: 'settled', txid: TXID, trade: spotProps });
    assert.equal(sock.listenerCount('swap'), 0, 'the listener was left attached');
});

test('buyer: an expired-unverified verdict gives unverified with the txid the buyer broadcast', async () => {
    const { sw, sock } = await buyerAtSigned();
    await waitFor(() => sentNames(sock).includes('BUYER:STEP6'));
    sock.serverState('expired-unverified');
    assert.deepEqual(await sw.ready, { status: 'unverified', txid: fx.TXID });
});

test('buyer: a broadcast that fails, with no such transaction on the node, aborts and sends TERMINATE_TRADE', async () => {
    const { sw, sock, deps } = await buyerAtSigned({ sendFails: true, onChain: false });
    const res = await sw.ready;
    assert.equal(res.status, 'aborted');
    assert.match(res.reason, /sendRawTransaction/);
    assert.equal(sentNames(sock).slice(-1)[0], 'TERMINATE_TRADE');
    assert.ok(deps.calls.rpc.includes('getrawtransaction'), 'the node was not asked whether the transaction exists');
});

test('buyer: a broadcast that fails but is on the node is reported as sent, and BUYER:STEP6 follows', async () => {
    const { sw, sock } = await buyerAtSigned({ sendFails: true, onChain: true });
    await waitFor(() => sentNames(sock).includes('BUYER:STEP6'));
    assert.ok(!sentNames(sock).includes('TERMINATE_TRADE'), 'a broadcast that happened was aborted');
    sock.serverState('settled', fx.TXID);
    assert.equal((await sw.ready).status, 'settled');
});

test('buyer: once the seller has signed, a TERMINATE from the orderbook is not honoured and nothing is aborted', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { sw, sock } = await buyerAtSigned();
    await waitFor(() => sentNames(sock).includes('BUYER:STEP6'));
    sock.deliver('TERMINATE_TRADE', 'too late', 'OB-S');
    t.mock.timers.tick(1);
    sock.serverState('expired-unverified');
    assert.equal((await sw.ready).status, 'unverified');
});

test('buyer: the signed window ends first, so the buyer does not broadcast', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { BuySwapper } = freshRequire('swapper/index.ts');
    const { ETradeType } = freshRequire('swapper/common.ts');
    const sock = new FakeSocket();
    const deps = makeBuyerDeps();
    const sw = new BuySwapper(SID, ETradeType.SPOT, spotProps, buyerParty, sellerParty, deps.node, sock, deps.txs);
    sock.deliver('SELLER:STEP1', { address: 'MS-ADDR', redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.MS }, 'OB-S');
    await waitFor(() => sentNames(sock).includes('BUYER:STEP2'));
    sock.deliver('SELLER:STEP3', COMMIT, 'OB-S');
    await waitFor(() => sentNames(sock).includes('BUYER:STEP4'));
    sock.deliver('SELLER:STEP5', hx('PSBT-B'), 'OB-S');
    t.mock.timers.tick(600000);
    const res = await sw.ready;
    assert.equal(res.status, 'unverified');
    await sleep(5);
    assert.ok(!deps.calls.sendTx.includes('FINAL-HEX'), 'the final transaction was broadcast after the window ended');
});

test('buyer: the negotiation times out after 60 s, with a TERMINATE and an aborted result', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { BuySwapper } = freshRequire('swapper/index.ts');
    const { ETradeType } = freshRequire('swapper/common.ts');
    const sock = new FakeSocket();
    const deps = makeBuyerDeps();
    const sw = new BuySwapper(SID, ETradeType.SPOT, spotProps, buyerParty, sellerParty, deps.node, sock, deps.txs);
    t.mock.timers.tick(60000);
    const res = await sw.ready;
    assert.deepEqual(res, { status: 'aborted', reason: 'Negotiation timed out' });
    assert.equal(sentNames(sock).slice(-1)[0], 'TERMINATE_TRADE');
});

test('seller: after its signature it never terminates; a verdict of expired-unverified reports the txid it signed', async () => {
    const { SellSwapper } = freshRequire('swapper/index.ts');
    const { ETradeType } = freshRequire('swapper/common.ts');
    const sock = new FakeSocket();
    const deps = makeBuyerDeps();
    const sw = new SellSwapper(SID, ETradeType.SPOT, spotProps, sellerParty, buyerParty, deps.node, sock, deps.txs);
    await waitFor(() => sentNames(sock).includes('SELLER:STEP1'));
    sock.serverState('expired-unverified');
    assert.deepEqual(await sw.ready, { status: 'unverified', txid: null }, 'no signature yet: nothing to report');
});
