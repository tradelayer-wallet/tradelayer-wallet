'use strict';

// LTC is property id 0: the orderbook's markets list, and the TradeLayer consensus id (Cardinal LTC = 0).
// The wallet used -1 for LTC in its own checks, so a trade the book sent with propIdForSale 0 was routed
// as a token trade by the buyer and refused as "not modelled" by the seller. These cases drive the real
// swapper classes with the trade shape the orderbook sends for an LTC leg.

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('events');
const { loadTs, REPO } = require('../support/ts-loader');
const fx = require('../support/psbt-fixture');

const UTILS_DIR = path.join(REPO, 'packages', 'wallet-fe', 'src', 'app', 'utils');
const freshRequire = (rel) => loadTs(path.join(UTILS_DIR, rel)).exports;

const SWAP_EVENT = 'swap';
const SID = 'c3'.repeat(32);
const PSBT1 = Buffer.from('PSBT-1').toString('hex');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, { timeout = 3000, interval = 10, message = 'condition' } = {}) => {
    const start = Date.now();
    for (;;) {
        if (fn()) return;
        if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${message}`);
        await sleep(interval);
    }
};

class FakeSocket extends EventEmitter {
    constructor() { super(); this.sent = []; }
    emit(ev, ...args) {
        if (ev === SWAP_EVENT) { this.sent.push(args[0]); return true; }
        return super.emit(ev, ...args);
    }
    deliver(eventName, data = null, socketId = 'OB-X') {
        return super.emit(SWAP_EVENT, { sessionId: SID, eventName, socketId, data });
    }
}
const sentNames = (sock) => sock.sent.map((e) => e.eventName);

const buyerParty = { keypair: { address: 'B-ADDR', pubkey: fx.BUYER_PUB }, socketId: 'OB-B' };
const sellerParty = { keypair: { address: 'S-ADDR', pubkey: fx.SELLER_PUB }, socketId: 'OB-S' };
// The LTC-for-token trade as the orderbook relays it: the taker sells LTC (propIdForSale 0) for
// token 11. One token at 2 LTC per token, in units and in satoshis.
const ltcTrade = { propIdDesired: 11, amountDesired: 100000000, propIdForSale: 0, amountForSale: 200000000, price: 200000000 };

// Node stub shared by both roles. `calls` records every RPC method, in order.
const nodeStub = (calls) => async (method, params = []) => {
    calls.push(method);
    switch (method) {
        case 'addmultisigaddress': return { data: { address: 'MS-ADDR', redeemScript: fx.REDEEM } };
        case 'validateaddress': return params[0] === 'MS-ADDR'
            ? { data: { isvalid: true, scriptPubKey: fx.SPK.MS } }
            : { data: { isvalid: false } };
        case 'tl_getinfo': return { data: { block: fx.TIP } };
        case 'tl_createpayload_instant_ltc_trade': return { data: 'PAY-LTC' };
        case 'tl_createpayload_commit_tochannel': return { data: 'PAY-COMMIT' };
        case 'decoderawtransaction': return { data: { vout: [{ value: 2, n: 0, scriptPubKey: { addresses: ['MS-ADDR'], hex: fx.SPK.MS } }] } };
        case 'decodepsbt': return params[0] === PSBT1 ? { data: { tx: { txid: fx.TXID } } } : { error: 'TX decode failed' };
        default: return { error: `unstubbed rpc ${method}` };
    }
};

const txsStub = () => ({
    getWifByAddress: () => 'WIF',
    buildTx: async () => ({ data: { inputs: [], rawtx: 'RAW-COMMIT' } }),
    signTx: async () => ({ data: { isValid: true, signedHex: 'SIGNED-COMMIT' } }),
    sendTx: async () => ({ data: fx.COMMIT_TXID }),
    buildLTCITTx: async () => ({ data: { psbtHex: PSBT1 } }),
});

const commitUtxo = { txid: fx.COMMIT_TXID, vout: 0, sats: 200000000, scriptPubKey: fx.SPK.MS_PSBT, redeemScript: fx.REDEEM };

test('LTC is property id 0, and the order builder sends it unchanged', () => {
    const units = freshRequire('units.ts');
    assert.equal(units.LTC_PROPERTY_ID, 0);
    const order = units.toWireOrder({ action: 'SELL', props: { amount: 1, price: 1, id_for_sale: units.LTC_PROPERTY_ID, id_desired: 1 } });
    assert.equal(order.props.id_for_sale, 0);
});

test('the wallet accepts property id 0 in a trade from the book', () => {
    const { parseTrade } = freshRequire('swapper/protocol.ts');
    const parsed = parseTrade({
        type: 'SPOT', taker: 'T', maker: 'M',
        buyer: buyerParty, seller: sellerParty,
        props: { propIdDesired: 11, propIdForSale: 0, amountDesired: 100000000, amountForSale: 200000000, price: 200000000 },
    });
    assert.ok(parsed.data, `trade with LTC id 0 refused: ${parsed.error}`);
    assert.equal(parsed.data.props.propIdForSale, 0);
});

test('the buyer of an LTC-for-token trade takes the LTC branch (instant LTC trade), not the token branch', async () => {
    const { BuySwapper } = freshRequire('swapper/index.ts');
    const { ETradeType } = freshRequire('swapper/common.ts');
    const sock = new FakeSocket();
    const calls = [];
    const sw = new BuySwapper(SID, ETradeType.SPOT, ltcTrade, buyerParty, sellerParty, nodeStub(calls), sock, txsStub());
    sock.deliver('SELLER:STEP1', { address: 'MS-ADDR', redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.MS }, 'OB-S');
    await waitFor(() => sentNames(sock).includes('BUYER:STEP2'), { message: 'BUYER:STEP2' });
    sock.deliver('SELLER:STEP3', commitUtxo, 'OB-S');
    await waitFor(() => calls.some((m) => m.startsWith('tl_createpayload_')), { message: 'trade payload request' });
    const payloadCall = calls.find((m) => m.startsWith('tl_createpayload_'));
    assert.equal(payloadCall, 'tl_createpayload_instant_ltc_trade');
    sw.terminateTrade('test over');
});

test('the seller of an LTC-for-token trade treats it as modelled and commits its tokens', async () => {
    const { SellSwapper } = freshRequire('swapper/index.ts');
    const { ETradeType } = freshRequire('swapper/common.ts');
    const sock = new FakeSocket();
    const calls = [];
    const sw = new SellSwapper(SID, ETradeType.SPOT, ltcTrade, sellerParty, buyerParty, nodeStub(calls), sock, txsStub());
    await waitFor(() => sentNames(sock).includes('SELLER:STEP1'), { message: 'SELLER:STEP1' });
    sock.deliver('BUYER:STEP2', null, 'OB-B');
    await waitFor(() => sentNames(sock).includes('SELLER:STEP3') || sentNames(sock).includes('TERMINATE_TRADE'), { message: 'seller decision' });
    assert.ok(sentNames(sock).includes('SELLER:STEP3'), `seller refused an LTC-leg trade: ${JSON.stringify(sock.sent.at(-1))}`);
    sw.terminateTrade('test over');
});
