'use strict';

// Buyer side of the swap, driven through the real BuySwapper class. The socket is an
// in-process fake and the RPC and tx services are stubs, so no node or network is needed.
// Regression cases: the channel address the buyer pays its commit to must be the one its own
// node derives from the redeem script, and a throw while signing must end the swap.

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('events');
const { loadTs, REPO } = require('../support/ts-loader');
const fx = require('../support/psbt-fixture');

// The PSBT the stubs return, as hex on the wire.
const PSBT1 = Buffer.from('PSBT-1').toString('hex');
const SWAP_EVENT = 'swap';
const SID = 'b1'.repeat(32);
const UTILS_DIR = path.join(REPO, 'packages', 'wallet-fe', 'src', 'app', 'utils');
const freshRequire = (rel) => loadTs(path.join(UTILS_DIR, rel.replace(/\.js$/, '.ts'))).exports;

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
    deliver(eventName, data = null, socketId = 'OB-S') {
        return super.emit(SWAP_EVENT, { sessionId: SID, eventName, socketId, data });
    }
}

const sentNames = (sock) => sock.sent.map((e) => e.eventName);
const lastSent = (sock) => sock.sent[sock.sent.length - 1];

const buyerParty = { keypair: { address: 'B-ADDR', pubkey: fx.BUYER_PUB }, socketId: 'OB-B' };
const sellerParty = { keypair: { address: 'S-ADDR', pubkey: fx.SELLER_PUB }, socketId: 'OB-S' };
// The LTC-for-token spot trade: the only trade the seller models, so the one the buyer runs.
const ltcTrade = { propIdDesired: 11, amountDesired: 100000000, propIdForSale: 0, amountForSale: 200000000, price: 200000000 };
// Token-for-token spot trade: not modelled. The buyer must refuse it before it commits anything.
const tokenTrade = { propIdDesired: 11, amountDesired: 100000000, propIdForSale: 12, amountForSale: 100000000, price: 100000000 };

const makeState = () => ({
    buildTxTo: [],
    broadcasts: 0,
    trade: [],
    signed: [],
    signThrows: false,
});

// Script each address encodes on this node: the P2WSH and P2SH-P2WSH forms of the channel redeem script,
// and a valid address for a different 2-of-2 (not this trade's channel).
const SCRIPT_OF = {
    'MS-ADDR': fx.SPK.MS, // P2WSH of the redeem script (the buyer's own node)
    'MS-SELLER-ENC': fx.SPK.MS, // the same P2WSH script, as a counterparty node may encode it
    'MS-P2SH': fx.p2shOf(fx.p2wshOf(fx.REDEEM)), // P2SH-P2WSH of the same redeem script
    'MS-OTHER': fx.p2wshOf('5151'), // a different witness script
};

const nodeStub = () => async (method, params = []) => {
    switch (method) {
        case 'addmultisigaddress': return { data: { address: 'MS-ADDR', redeemScript: fx.REDEEM } };
        case 'validateaddress': return SCRIPT_OF[params[0]]
            ? { data: { isvalid: true, scriptPubKey: SCRIPT_OF[params[0]] } }
            : { data: { isvalid: false } };
        case 'tl_getinfo': return { data: { block: fx.TIP } };
        case 'tl_createpayload_commit_tochannel': return { data: 'PAY-COMMIT' };
        case 'tl_createpayload_instant_ltc_trade': return { data: 'PAY-LTC' };
        case 'decoderawtransaction': return { data: { vout: [{ value: 2, n: 0, scriptPubKey: { addresses: ['MS-ADDR'], hex: fx.SPK.MS } }] } };
        case 'decodepsbt': return params[0] === PSBT1
            ? { data: { tx: { txid: fx.TXID } } }
            : { error: 'TX decode failed' };
        default: return { error: `unstubbed rpc ${method}` };
    }
};

const txsStub = (state) => ({
    getWifByAddress: () => 'WIF',
    buildTx: async (cfg) => {
        state.buildTxTo.push(cfg.toKeyPair.address);
        return { data: { inputs: [], rawtx: 'RAW-COMMIT' } };
    },
    signTx: async () => ({ data: { isValid: true, signedHex: 'SIGNED-COMMIT' } }),
    sendTx: async () => { state.broadcasts++; return { data: fx.COMMIT_TXID }; },
    buildLTCITTx: async (cfg) => { state.trade.push(cfg); return { data: { psbtHex: PSBT1 } }; },
    signPsbt: async ({ psbtHex }) => {
        state.signed.push(psbtHex);
        if (state.signThrows) throw new Error('signer unavailable');
        return { data: { psbtHex, isFinished: true, finalHex: 'FINAL-HEX' } };
    },
});

const startBuyer = (trade = ltcTrade) => {
    const { BuySwapper } = freshRequire('swapper/index.js');
    const { ETradeType } = freshRequire('swapper/common.js');
    const sock = new FakeSocket();
    const state = makeState();
    const sw = new BuySwapper(SID, ETradeType.SPOT, trade, buyerParty, sellerParty, nodeStub(), sock, txsStub(state));
    return { sw, sock, state };
};

const commitUtxo = { txid: fx.COMMIT_TXID, vout: 0, sats: 200000000, scriptPubKey: fx.SPK.MS_PSBT, redeemScript: fx.REDEEM };

// Drives a buyer through step 3, so the commit is built and the trade PSBT is sent (BUYER:STEP4).
const buyerAtStep4 = async (step1Data) => {
    const b = startBuyer();
    b.sock.deliver('SELLER:STEP1', step1Data);
    await waitFor(() => sentNames(b.sock).includes('BUYER:STEP2'), { message: 'BUYER:STEP2' });
    b.sock.deliver('SELLER:STEP3', commitUtxo);
    await waitFor(() => sentNames(b.sock).includes('BUYER:STEP4'), { message: 'BUYER:STEP4' });
    return b;
};

test('an honest SELLER:STEP1 is answered with BUYER:STEP2', async () => {
    const b = startBuyer();
    b.sock.deliver('SELLER:STEP1', { address: 'MS-ADDR', redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.MS });
    await waitFor(() => sentNames(b.sock).includes('BUYER:STEP2'), { message: 'BUYER:STEP2' });
    assert.ok(!sentNames(b.sock).includes('TERMINATE_TRADE'));
});

test('REGRESSION: a SELLER:STEP1 whose channel address is not the one its redeem script derives is refused', async () => {
    // The redeem script is the real channel script, so the old redeem-script-only check passes.
    // The address is the counterparty's own, and the commit would be paid there at step 3.
    const b = startBuyer();
    b.sock.deliver('SELLER:STEP1', { address: 'ATTACKER-ADDR', redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.S });
    await waitFor(() => lastSent(b.sock)?.eventName === 'TERMINATE_TRADE', { message: 'refusal' });
    const res = await b.sw.ready;
    assert.match(String(res.reason), /^Step 1: address of Multysig is not matching$/);
    assert.ok(!sentNames(b.sock).includes('BUYER:STEP2'), 'BUYER:STEP2 sent after a mismatched address');
    // The commit that would follow is never built, so nothing is paid to the attacker address.
    b.sock.deliver('SELLER:STEP3', commitUtxo);
    await sleep(20);
    assert.deepStrictEqual(b.state.buildTxTo, []);
    assert.equal(b.state.broadcasts, 0);
});

test('the LTC trade spends the seller commit output, and the buyer broadcasts nothing before the seller signs', async () => {
    const b = await buyerAtStep4({ address: 'MS-ADDR', redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.MS });
    assert.deepStrictEqual(b.state.buildTxTo, [], 'the buyer built a commit of its own');
    assert.equal(b.state.broadcasts, 0);
    const trade = b.state.trade[0];
    assert.equal(trade.commitUTXOs.length, 1);
    assert.equal(trade.commitUTXOs[0].txid, fx.COMMIT_TXID);
    assert.equal(trade.commitUTXOs[0].vout, commitUtxo.vout);
});

test('REGRESSION: a throw while signing at SELLER:STEP5 ends the swap with a Step 5 reason instead of an unhandled rejection', async () => {
    const b = await buyerAtStep4({ address: 'MS-ADDR', redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.MS });
    b.state.signThrows = true;
    b.sock.deliver('SELLER:STEP5', PSBT1);
    const res = await b.sw.ready;
    assert.match(String(res.reason), /^Step 5: signer unavailable$/);
    assert.deepStrictEqual(sentNames(b.sock).slice(-1), ['TERMINATE_TRADE']);
    assert.equal(b.state.broadcasts, 0, 'nothing is broadcast before the seller signs');
});

test('an honest seller whose address encodes the same P2WSH channel with a different string is accepted and answered with BUYER:STEP4', async () => {
    // Seller and buyer nodes may differ in address type, so the same script is written differently.
    // The old check compared address strings and refused this honest step.
    const b = startBuyer();
    b.sock.deliver('SELLER:STEP1', { address: 'MS-SELLER-ENC', redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.MS });
    await waitFor(() => sentNames(b.sock).includes('BUYER:STEP2'), { message: 'BUYER:STEP2' });
    assert.ok(!sentNames(b.sock).includes('TERMINATE_TRADE'), 'honest P2WSH channel refused');
    b.sock.deliver('SELLER:STEP3', commitUtxo);
    await waitFor(() => sentNames(b.sock).includes('BUYER:STEP4'), { message: 'BUYER:STEP4' });
    assert.ok(!sentNames(b.sock).includes('TERMINATE_TRADE'), 'honest P2WSH channel refused at step 3');
});

test('a P2SH-P2WSH channel is refused at SELLER:STEP1, so no commit is built or broadcast', async () => {
    // The commit input of a P2SH channel cannot be signed on the PSBT path, so the trade would fail
    // after the commit was paid. The buyer refuses it first.
    const b = startBuyer();
    b.sock.deliver('SELLER:STEP1', { address: 'MS-P2SH', redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.MS });
    await waitFor(() => lastSent(b.sock)?.eventName === 'TERMINATE_TRADE', { message: 'refusal' });
    const res = await b.sw.ready;
    assert.match(String(res.reason), /^Step 1: address of Multysig is not matching$/);
    b.sock.deliver('SELLER:STEP3', commitUtxo);
    await sleep(20);
    assert.deepStrictEqual(b.state.buildTxTo, []);
    assert.equal(b.state.broadcasts, 0);
});

test('a valid address for a different 2-of-2 or witness script is refused at SELLER:STEP1', async () => {
    const b = startBuyer();
    b.sock.deliver('SELLER:STEP1', { address: 'MS-OTHER', redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.MS });
    await waitFor(() => lastSent(b.sock)?.eventName === 'TERMINATE_TRADE', { message: 'refusal' });
    const res = await b.sw.ready;
    assert.match(String(res.reason), /^Step 1: address of Multysig is not matching$/);
    assert.ok(!sentNames(b.sock).includes('BUYER:STEP2'));
});

test('REGRESSION: a SELLER:STEP3 for a token-for-token trade is refused before any commit is broadcast', async () => {
    // The seller refuses this trade before its own commit (Step 2), so an honest seller never sends
    // SELLER:STEP3 for it. A seller that sends it anyway must not get the buyer's tokens committed.
    const b = startBuyer(tokenTrade);
    b.sock.deliver('SELLER:STEP1', { address: 'MS-ADDR', redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.MS });
    await waitFor(() => sentNames(b.sock).includes('BUYER:STEP2'), { message: 'BUYER:STEP2' });
    b.sock.deliver('SELLER:STEP3', commitUtxo);
    await waitFor(() => sentNames(b.sock).includes('TERMINATE_TRADE') || sentNames(b.sock).includes('BUYER:STEP4'), { message: 'buyer decision' });
    assert.ok(!sentNames(b.sock).includes('BUYER:STEP4'), 'BUYER:STEP4 sent for an unmodelled trade');
    assert.deepStrictEqual(b.state.buildTxTo, []);
    assert.equal(b.state.broadcasts, 0);
    assert.match(String((await b.sw.ready).reason), /^Step 3: trade not modelled/);
});

test('REGRESSION: a SELLER:STEP3 for a futures trade is refused before any commit is broadcast', async () => {
    const { BuySwapper } = freshRequire('swapper/index.js');
    const { ETradeType } = freshRequire('swapper/common.js');
    const sock = new FakeSocket();
    const state = makeState();
    const futures = { contract_id: 7, amount: 100000000, price: 100000000, levarage: 1, collateral: 0 };
    const sw = new BuySwapper(SID, ETradeType.FUTURES, futures, buyerParty, sellerParty, nodeStub(), sock, txsStub(state));
    sock.deliver('SELLER:STEP1', { address: 'MS-ADDR', redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.MS });
    await waitFor(() => sentNames(sock).includes('BUYER:STEP2'), { message: 'BUYER:STEP2' });
    sock.deliver('SELLER:STEP3', commitUtxo);
    await waitFor(() => sentNames(sock).includes('TERMINATE_TRADE') || sentNames(sock).includes('BUYER:STEP4'), { message: 'buyer decision' });
    assert.deepStrictEqual(state.buildTxTo, []);
    assert.equal(state.broadcasts, 0);
    assert.match(String((await sw.ready).reason), /^Step 3: trade not modelled/);
});
