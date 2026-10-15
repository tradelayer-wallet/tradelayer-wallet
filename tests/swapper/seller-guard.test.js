'use strict';

/*
 * Round-6 suite: the round-5 coverage (fixtures now use real BIP49 keys and the relayer's
 * PSBT script forms) plus the round-6 cases, appended below.
 *
 * Round-5 coverage: the seller checks the PSBT it is asked to sign against the agreed
 * trade before it signs. Offline only. The socket is an in-process fake; RPC and txs
 * are stubs that model the relayer's transaction (see psbt-fixture.js).
 *
 * Refused cases must: sign nothing, send TERMINATE_TRADE with a "Step 4" reason, settle
 * the swap, detach the listener, and ignore any later step.
 */
const path = require('path');
const assert = require('node:assert/strict');
const { test: nodeTest } = require('node:test');
const { EventEmitter } = require('events');
const { loadTs, REPO } = require('../support/ts-loader');
const fx = require('../support/psbt-fixture');

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, { timeout = 5000, interval = 25, message = 'condition' } = {}) => {
    const start = Date.now();
    for (;;) {
        let v;
        try { v = fn(); } catch (e) { v = false; }
        if (v) return v;
        if (Date.now() - start > timeout) throw new Error(`waitFor timed out after ${timeout}ms: ${message}`);
        await sleep(interval);
    }
};

const SWAP_EVENT = 'swap';
const FINAL_TXID = 'f'.repeat(64);
const UTILS_DIR = path.join(REPO, 'packages', 'wallet-fe', 'src', 'app', 'utils');
// Loads the wallet-fe swapper source, transpiled in memory. Fresh instance on every call.
const freshRequire = (rel) => loadTs(path.join(UTILS_DIR, rel.replace(/\.js$/, '.ts'))).exports;

class FakeSocket extends EventEmitter {
    constructor() { super(); this.sent = []; }
    emit(ev, ...args) {
        if (ev === SWAP_EVENT) { this.sent.push(args[0]); return true; }
        return super.emit(ev, ...args);
    }
    deliver(ev, ...args) { return super.emit(ev, ...args); }
}

// PSBT payloads are hex on the wire (protocol-v2.md B.3.5); the fixtures name them by text.
const hx = (text) => Buffer.from(text).toString('hex');
const P = hx('P');

const sentNames = (sock) => sock.sent.map((e) => e.eventName);
const inbound = (sock, sid, eventName, data = null, socketId = 'OB-B') =>
    sock.deliver(SWAP_EVENT, { sessionId: sid, eventName, socketId, data });

const sellerParty = { keypair: { address: 'S-ADDR', pubkey: fx.SELLER_PUB }, socketId: 'OB-S' };
const buyerParty = { keypair: { address: 'B-ADDR', pubkey: fx.BUYER_PUB }, socketId: 'OB-B' };
// Integer units: 1 token, 1 LTC (1e8 sats), and 1 LTC per token in sats per whole token.
const spotProps = { propIdDesired: 11, amountDesired: 100000000, propIdForSale: -1, amountForSale: 100000000, price: 100000000 };

// Node stub. `state.psbts` maps a PSBT hex to its decodepsbt result (or an error).
const nodeStub = (state) => async (method, params = []) => {
    if (state.over[method]) return state.over[method](params);
    switch (method) {
        case 'addmultisigaddress': return { data: { address: 'MS-ADDR', redeemScript: fx.REDEEM } };
        case 'validateaddress': {
            const script = fx.ADDR[params[0]];
            return script ? { data: { isvalid: true, scriptPubKey: script } } : { data: { isvalid: false } };
        }
        case 'tl_getinfo': return { data: { block: fx.TIP } };
        case 'tl_createpayload_commit_tochannel': return { data: 'PAY-COMMIT' };
        case 'tl_createpayload_instant_ltc_trade': {
            const [prop, amountDesired, price, expiry] = params;
            return { data: fx.payloadFor(expiry, { prop, amountDesired, price }) };
        }
        case 'tl_createrawtx_reference': return { data: 'REF-RAW' };
        case 'tl_createrawtx_opreturn': return { data: `OPRET-RAW:${params[1]}` };
        case 'decoderawtransaction': {
            const raw = params[0];
            if (raw === 'RAW-COMMIT') {
                return { data: { vout: [{ value: 2, n: 0, scriptPubKey: { addresses: ['MS-ADDR'], hex: fx.SPK.MS } }] } };
            }
            if (raw === 'REF-RAW') return { data: { vout: [{ value: fx.DUST / fx.LTC, n: 0, scriptPubKey: { hex: fx.SPK.S } }] } };
            if (raw.startsWith('OPRET-RAW:')) {
                return { data: { vout: [{ value: 0, n: 0, scriptPubKey: { hex: fx.opReturnFor(raw.slice('OPRET-RAW:'.length)) } }] } };
            }
            return { error: `unstubbed raw ${raw}` };
        }
        case 'decodepsbt': {
            const d = state.psbts[params[0]];
            return d === undefined ? { error: 'TX decode failed' } : (d.error ? { error: d.error } : { data: d });
        }
        default: return { error: `unstubbed rpc ${method}` };
    }
};

const makeTxs = (state) => ({
    calls: state.calls,
    getWifByAddress: () => 'WIF',
    buildTx: async () => { state.calls.buildCommit++; return { data: { inputs: [], rawtx: 'RAW-COMMIT' } }; },
    signTx: async () => ({ data: { isValid: true, signedHex: 'SIGNED-COMMIT' } }),
    sendTx: async () => { state.calls.broadcast++; return { data: fx.COMMIT_TXID }; },
    signPsbt: async ({ psbtHex }) => {
        state.calls.sign.push(psbtHex);
        // The signed PSBT decodes as the same transaction, with the seller's signature on input 0.
        const signed = `SIGNED:${psbtHex}`;
        if (state.psbts[psbtHex] && !state.psbts[psbtHex].error) state.psbts[signed] = fx.withSellerSignature(state.psbts[psbtHex]);
        return { data: { psbtHex: signed, isFinished: false } };
    },
});

// A seller that has created its commit and is waiting for the buyer's PSBT (BUYER:STEP4).
const sellerAtStep3 = async (sid, { props = spotProps, over = {} } = {}) => {
    const { SellSwapper } = freshRequire('swapper/index.js');
    const { ETradeType } = freshRequire('swapper/common.js');
    const sock = new FakeSocket();
    const state = { psbts: {}, over, calls: { sign: [], buildCommit: 0, broadcast: 0 } };
    const sw = new SellSwapper(sid, ETradeType.SPOT, props, sellerParty, buyerParty, nodeStub(state), sock, makeTxs(state));
    await waitFor(() => sentNames(sock).includes('SELLER:STEP1'), { message: 'SELLER:STEP1' });
    inbound(sock, sid, 'BUYER:STEP2');
    await waitFor(() => sentNames(sock).includes('SELLER:STEP3'), { message: 'SELLER:STEP3' });
    return { sw, sock, state };
};

const settle = (sw, ms = 3000) => Promise.race([
    sw.ready,
    sleep(ms).then(() => { throw new Error(`swap did not settle within ${ms} ms`); }),
]);

// Delivers a BUYER:STEP4 carrying `decoded` and asserts the refusal contract.
const expectRefused = async (sid, decoded, reasonRe, opts = {}) => {
    const { sw, sock, state } = await sellerAtStep3(sid, opts);
    const psbtHex = hx(`PSBT-${sid.slice(0, 8)}`);
    state.psbts[psbtHex] = decoded;
    inbound(sock, sid, 'BUYER:STEP4', psbtHex);
    const res = await settle(sw);
    assert.match(String(res.reason), reasonRe, `wrong refusal reason: ${res.reason}`);
    assert.match(String(res.reason), /^Step 4: /, `refusal not from step 4: ${res.reason}`);
    assert.strictEqual(state.calls.sign.length, 0, `signed a refused PSBT: ${state.calls.sign}`);
    assert.deepStrictEqual(sentNames(sock).slice(-1), ['TERMINATE_TRADE'], 'no TERMINATE_TRADE sent');
    assert.ok(!sentNames(sock).includes('SELLER:STEP5'), 'SELLER:STEP5 sent for a refused PSBT');
    assert.strictEqual(sock.listenerCount(SWAP_EVENT), 0, 'listener left after refusal');
    // Nothing after the refusal: a later step with the same PSBT is ignored.
    inbound(sock, sid, 'BUYER:STEP4', psbtHex);
    await sleep(20);
    assert.strictEqual(state.calls.sign.length, 0, 'a settled seller signed after refusal');
    assert.deepStrictEqual(sentNames(sock).slice(-1), ['TERMINATE_TRADE']);
    return res;
};

// ---- the seller signs the honest transaction, and only that ----------------------
const test = (name, fn) => nodeTest(name, fn);

test('honest PSBT is signed once; the swap then completes on BUYER:STEP6', async () => {
    const S = '1'.repeat(64);
    const { sw, sock, state } = await sellerAtStep3(S);
    const psbtHex = hx('PSBT-HONEST');
    state.psbts[psbtHex] = fx.decodedFrom(fx.honestSpec());
    inbound(sock, S, 'BUYER:STEP4', psbtHex);
    await waitFor(() => sentNames(sock).includes('SELLER:STEP5'), { message: 'SELLER:STEP5' });
    assert.deepStrictEqual(state.calls.sign, [psbtHex], 'honest PSBT not signed exactly once');
    assert.strictEqual(sock.sent.find((e) => e.eventName === 'SELLER:STEP5').data, `SIGNED:${psbtHex}`);
    const txid = state.psbts[psbtHex].tx.txid;
    inbound(sock, S, 'BUYER:STEP6', txid, 'OB-B');
    const res = await settle(sw);
    assert.deepStrictEqual(res, { status: 'settled', txid, trade: spotProps });
    assert.strictEqual(sock.listenerCount(SWAP_EVENT), 0);
});

test('BUYER:STEP6 with a txid other than the signed transaction is refused', async () => {
    const S = '4'.repeat(64);
    const { sw, sock, state } = await sellerAtStep3(S);
    state.psbts[P] = fx.decodedFrom(fx.honestSpec());
    inbound(sock, S, 'BUYER:STEP4', P);
    await waitFor(() => sentNames(sock).includes('SELLER:STEP5'), { message: 'SELLER:STEP5' });
    inbound(sock, S, 'BUYER:STEP6', FINAL_TXID, 'OB-B');
    // The seller finishes unverified with the txid it signed, and sends nothing after its signature.
    const res = await settle(sw);
    assert.deepStrictEqual(res, { status: 'unverified', txid: state.psbts[P].tx.txid });
    assert.deepStrictEqual(sentNames(sock).slice(-1), ['SELLER:STEP5']);
});

test('honest PSBT with a buyer-funded input and an expiry at the window edge is signed', async () => {
    for (const expiry of [fx.EXPIRY - 6, fx.EXPIRY + 6]) {
        const sid = '2'.repeat(60) + String(expiry).padStart(4, '0');
        const { sw, sock, state } = await sellerAtStep3(sid);
        state.psbts[P] = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC, expiry }));
        inbound(sock, sid, 'BUYER:STEP4', P);
        await waitFor(() => sentNames(sock).includes('SELLER:STEP5'), { message: `signed at expiry ${expiry}` });
        assert.deepStrictEqual(state.calls.sign, [P]);
        inbound(sock, sid, 'SERVER:STATE', { state: 'expired-unverified', txid: null }, null);
        await sw.ready;
    }
});

test('replayed BUYER:STEP4 with the same honest PSBT signs once', async () => {
    const S = '3'.repeat(64);
    const { sw, sock, state } = await sellerAtStep3(S);
    state.psbts[P] = fx.decodedFrom(fx.honestSpec());
    inbound(sock, S, 'BUYER:STEP4', P);
    inbound(sock, S, 'BUYER:STEP4', P);
    await waitFor(() => sentNames(sock).includes('SELLER:STEP5'), { message: 'SELLER:STEP5' });
    await sleep(20);
    assert.deepStrictEqual(state.calls.sign, [P], 'replayed step signed again');
    inbound(sock, S, 'SERVER:STATE', { state: 'expired-unverified', txid: null }, null);
    await sw.ready;
});

// ---- refusals: every one signs nothing and terminates the swap -------------------
const spec = () => fx.honestSpec();
const withOutputs = (s, fn) => { fn(s.outputs); return s; };

test('extra output split off the buyer change is refused', async () => {
    const s = spec();
    s.outputs[0].sats -= 1000;
    s.outputs.push({ sats: 1000, scriptHex: fx.SPK.B });
    await expectRefused('4'.repeat(64), fx.decodedFrom(s), /PSBT refused: (buyer output|output set)/);
});

test('buyer change inflated by one satoshi is refused', async () => {
    const s = withOutputs(spec(), (o) => { o[0].sats += 1; });
    await expectRefused('5'.repeat(64), fx.decodedFrom(s), /buyer output is/);
});

test('seller paid one satoshi less, the buyer gains it, is refused', async () => {
    const s = withOutputs(spec(), (o) => { o[1].sats -= 1; o[0].sats += 1; });
    await expectRefused('6'.repeat(64), fx.decodedFrom(s), /(seller|buyer) output is/);
});

test('altered TL payload (amount) in the OP_RETURN is refused', async () => {
    const s = spec();
    s.outputs[2].scriptHex = fx.opReturnFor(fx.payloadFor(fx.EXPIRY, { amountDesired: '2' }));
    await expectRefused('7'.repeat(64), fx.decodedFrom(s), /not one of the expected outputs/);
});

test('OP_RETURN payload with an expiry outside the accepted window is refused', async () => {
    const s = spec();
    s.outputs[2].scriptHex = fx.opReturnFor(fx.payloadFor(fx.EXPIRY + 7));
    await expectRefused('8'.repeat(64), fx.decodedFrom(s), /not one of the expected outputs/);
});

test('missing OP_RETURN payload is refused', async () => {
    const s = spec();
    s.outputs.pop();
    await expectRefused('9'.repeat(64), fx.decodedFrom(s), /output set differs/);
});

test('OP_RETURN that carries value is refused', async () => {
    const s = spec();
    s.outputs[2].sats = 1;
    await expectRefused('a'.repeat(64), fx.decodedFrom(s), /OP_RETURN output carries value/);
});

test('an extra input the seller owns is refused, even with a balanced change', async () => {
    // Commit + a seller-address UTXO, change rebalanced so only the input rule can refuse.
    const s = spec();
    s.inputs.push({ txid: 'e'.repeat(64), vout: 0, sats: 50000000, scriptHex: fx.SPK.S });
    s.outputs[0].sats = fx.honestSpec().outputs[0].sats + 50000000 - 60000;
    await expectRefused('b'.repeat(64), fx.decodedFrom(s), /input 1 is not at the buyer's address/);
});

test('the commit output replaced by another channel output is refused', async () => {
    const s = spec();
    s.inputs[0].txid = 'f'.repeat(64);
    await expectRefused('c'.repeat(64), fx.decodedFrom(s), /not at the buyer's address|does not match the commit/);
});

test('a commit input with a different amount than the seller created is refused', async () => {
    const s = spec();
    s.inputs[0].sats = 2 * fx.LTC - 1000;
    s.outputs[0].sats -= 1000;
    await expectRefused('d'.repeat(64), fx.decodedFrom(s), /commit input does not match/);
});

test('a PSBT without the seller commit input is refused', async () => {
    const s = {
        inputs: [{ txid: fx.FUND_TXID, vout: 1, sats: 3 * fx.LTC, scriptHex: fx.SPK.B }],
        outputs: [
            { sats: 3 * fx.LTC - fx.LTC - fx.FEE_PER_INPUT, scriptHex: fx.SPK.B },
            { sats: fx.LTC, scriptHex: fx.SPK.S },
            { sats: 0, scriptHex: fx.opReturnFor(fx.payloadFor(fx.EXPIRY)) },
        ],
    };
    await expectRefused('e'.repeat(64), fx.decodedFrom(s), /commit input missing/);
});

test('a repeated input is refused', async () => {
    const s = spec();
    s.inputs.push({ ...s.inputs[0] });
    s.outputs[0].sats += 2 * fx.LTC - fx.FEE_PER_INPUT;
    await expectRefused('f'.repeat(64), fx.decodedFrom(s), /repeats an earlier input/);
});

test('an excessive fee (one LTC taken from the buyer change) is refused', async () => {
    const s = withOutputs(fx.honestSpec({ fundSats: fx.LTC }), (o) => { o[0].sats -= fx.LTC; });
    await expectRefused('0a'.repeat(32), fx.decodedFrom(s), /buyer output is/);
});

test('a fee above the bounded maximum is refused even when it matches the input count', async () => {
    const inputs = [{ txid: fx.COMMIT_TXID, vout: 0, sats: 2 * fx.LTC, scriptHex: fx.SPK.MS }];
    for (let i = 1; i <= 100; i++) inputs.push({ txid: i.toString(16).padStart(64, '0'), vout: 0, sats: fx.LTC / 10, scriptHex: fx.SPK.B });
    const total = inputs.reduce((a, i) => a + i.sats, 0);
    const fee = inputs.length * fx.FEE_PER_INPUT;
    const s = { inputs, outputs: [
        { sats: total - fx.LTC - fee, scriptHex: fx.SPK.B },
        { sats: fx.LTC, scriptHex: fx.SPK.S },
        { sats: 0, scriptHex: fx.opReturnFor(fx.payloadFor(fx.EXPIRY)) },
    ] };
    await expectRefused('0b'.repeat(32), fx.decodedFrom(s), /fee above the maximum/);
});

test('a PSBT with a nonzero locktime is refused', async () => {
    const s = spec();
    s.locktime = 500000;
    await expectRefused('0c'.repeat(32), fx.decodedFrom(s), /transaction has a locktime/);
});

test('an output to an address that is neither party nor the channel is refused', async () => {
    const s = withOutputs(spec(), (o) => { o[0].scriptHex = fx.SPK.OTHER; });
    await expectRefused('0d'.repeat(32), fx.decodedFrom(s), /output 0 is not one of the expected outputs/);
});

test('malformed PSBT: decodepsbt error is refused', async () => {
    await expectRefused('0e'.repeat(32), { error: 'TX decode failed' }, /decodepsbt: TX decode failed/);
});

test('malformed PSBT: no transaction object is refused', async () => {
    await expectRefused('0f'.repeat(32), { inputs: [] }, /tx missing or not an object/);
});

test('malformed PSBT: an output value that is not a number is refused', async () => {
    const d = fx.decodedFrom(spec());
    d.tx.vout[1].value = 'one';
    await expectRefused('10'.repeat(32), d, /output 1 value is not a non-negative number/);
});

test('malformed PSBT: an output with no script is refused', async () => {
    const d = fx.decodedFrom(spec());
    delete d.tx.vout[0].scriptPubKey;
    await expectRefused('11'.repeat(32), d, /output 0 scriptPubKey missing/);
});

test('malformed PSBT: an input without its witness amount is refused', async () => {
    const d = fx.decodedFrom(spec());
    delete d.inputs[0].witness_utxo;
    await expectRefused('12'.repeat(32), d, /input 0 witness_utxo missing/);
});

test('malformed PSBT: a fractional satoshi amount is refused', async () => {
    const d = fx.decodedFrom(spec());
    d.tx.vout[1].value = fx.LTC / 1e8 + 0.000000015; // 1.5e-8 LTC on top of 1 LTC: not whole satoshis
    await expectRefused('13'.repeat(32), d, /not a whole number of satoshis/);
});

test('an expiry one block outside the accepted window is refused', async () => {
    await expectRefused('14'.repeat(32), fx.decodedFrom(honestWithExpiry(fx.EXPIRY + 7)), /not one of the expected outputs/);
});

const honestWithExpiry = (expiry) => fx.honestSpec({ expiry });

test('a token-for-token trade is refused before any PSBT is read', async () => {
    const S = '15'.repeat(32);
    const { SellSwapper } = freshRequire('swapper/index.js');
    const { ETradeType } = freshRequire('swapper/common.js');
    const sock = new FakeSocket();
    const state = { psbts: {}, over: {}, calls: { sign: [], buildCommit: 0, broadcast: 0 } };
    const sw = new SellSwapper(S, ETradeType.SPOT, { ...spotProps, propIdForSale: 10 }, sellerParty, buyerParty, nodeStub(state), sock, makeTxs(state));
    await waitFor(() => sentNames(sock).includes('SELLER:STEP1'));
    inbound(sock, S, 'BUYER:STEP2');
    const res = await settle(sw);
    assert.match(String(res.reason), /Step 2: trade not modelled/);
    // Refused before the commit is built or broadcast: no output is locked in the channel.
    assert.strictEqual(state.calls.buildCommit, 0, 'commit built for an unmodelled trade');
    assert.strictEqual(state.calls.broadcast, 0, 'commit broadcast for an unmodelled trade');
    assert.deepStrictEqual(state.calls.sign, []);
    assert.deepStrictEqual(sentNames(sock), ['SELLER:STEP1', 'TERMINATE_TRADE']);
    assert.strictEqual(sock.listenerCount(SWAP_EVENT), 0);
});

test('an RPC failure while rebuilding the expectation refuses, nothing is signed', async () => {
    const S = '16'.repeat(32);
    const { sw, sock, state } = await sellerAtStep3(S, {
        over: { validateaddress: (p) => (p[0] === 'B-ADDR' ? { error: 'node down' } : { data: { isvalid: true, scriptPubKey: fx.SPK.S } }) },
    });
    state.psbts[P] = fx.decodedFrom(spec());
    inbound(sock, S, 'BUYER:STEP4', P);
    const res = await settle(sw);
    assert.match(String(res.reason), /Step 4: validateaddress/);
    assert.deepStrictEqual(state.calls.sign, []);
});

test('psbtTxid and ltcToSats accept only well-formed values', async () => {
    const { psbtTxid, ltcToSats } = freshRequire('swapper/psbt-guard.js');
    assert.strictEqual(psbtTxid({ tx: { txid: 'AB'.repeat(32) } }), 'ab'.repeat(32));
    assert.strictEqual(psbtTxid({ tx: { txid: 'xyz' } }), null);
    assert.strictEqual(psbtTxid({}), null);
    assert.strictEqual(psbtTxid(null), null);
    assert.strictEqual(ltcToSats(0.00006), 6000);
    assert.throws(() => ltcToSats(-1), /PSBT refused/);
    assert.throws(() => ltcToSats(0.000000015), /PSBT refused/);
});

test('the validator, called directly, passes the honest transaction and refuses a single-sat change', async () => {
    const { assertPsbtMatchesTrade } = freshRequire('swapper/psbt-guard.js');
    assert.doesNotThrow(() => assertPsbtMatchesTrade(fx.decodedFrom(fx.honestSpec()), fx.expectation()));
    const s = fx.honestSpec();
    s.outputs[0].sats += 1;
    assert.throws(() => assertPsbtMatchesTrade(fx.decodedFrom(s), fx.expectation()), /buyer output is/);
});

// ---- round 6 -----------------------------------------------------------------------
// Realistic script forms: BIP49 trading addresses (P2SH-P2WPKH), the relayer's PSBT script
// forms (P2WPKH buyer witness, P2WSH commit witness), and the attack matrix on the validator.

const path6 = require('path');
const bitcoinR6 = require('bitcoinjs-lib');
// The relayer's own PSBT builder, transpiled from wallet-server/src/utils/crypto.util.ts.
// The relayer's own PSBT builder, loaded from the wallet-server source (not a copy).
const relayerUtil = loadTs(path6.join(REPO, 'packages', 'wallet-server', 'src', 'utils', 'crypto.util.ts')).exports;
const { assertPsbtMatchesTrade } = (() => { const { assertPsbtMatchesTrade: a } = freshRequire('swapper/psbt-guard.js'); return { assertPsbtMatchesTrade: a }; })();

const ZERO_SIG_BYTE = '01';
const SIGHASH_NAME = (t) => {
    const base = { 1: 'ALL', 2: 'NONE', 3: 'SINGLE' }[t & 0x1f];
    if (!base) return undefined;
    return (t & 0x80) ? `${base}|ANYONECANPAY` : base;
};
const revHex = (buf) => Buffer.from(buf).reverse().toString('hex');

// A decodepsbt result built from a PSBT hex, in the field shape Bitcoin/Litecoin Core print.
const decodeLikeCore = (psbtHex) => {
    const p = bitcoinR6.Psbt.fromHex(psbtHex);
    const unsigned = bitcoinR6.Transaction.fromBuffer(p.data.globalMap.unsignedTx.toBuffer());
    return {
        tx: {
            txid: unsigned.getId(),
            version: unsigned.version,
            locktime: unsigned.locktime,
            vin: unsigned.ins.map((i) => ({ txid: revHex(i.hash), vout: i.index, sequence: i.sequence })),
            vout: unsigned.outs.map((o, n) => ({ value: o.value / fx.LTC, n, scriptPubKey: { hex: o.script.toString('hex') } })),
        },
        inputs: p.data.inputs.map((inp) => {
            const rec = {};
            if (inp.witnessUtxo) rec.witness_utxo = { amount: inp.witnessUtxo.value / fx.LTC, scriptPubKey: { hex: inp.witnessUtxo.script.toString('hex') } };
            if (inp.sighashType !== undefined) rec.sighash = SIGHASH_NAME(inp.sighashType);
            return rec;
        }),
    };
};

// The relayer builds the trade PSBT exactly as buyer.ts asks for it (buildLTCInstatTx ->
// createrawtransaction -> tl_createrawtx_opreturn -> buildPsbt). Returns its psbt hex and the unsigned tx.
const relayerTradePsbt = ({ fundSats = 3 * fx.LTC, sellerSats = fx.LTC, expiry = fx.EXPIRY, buyerScript = fx.SPK.B, sellerScript = fx.SPK.S, extraOuts = [], drop = {} } = {}) => {
    const spec = fx.honestSpec({ fundSats, sellerSats, expiry, buyerScript, sellerScript });
    const tx = new bitcoinR6.Transaction();
    tx.version = 2;
    spec.inputs.forEach((i) => tx.addInput(Buffer.from(i.txid, 'hex').reverse(), i.vout, 0xffffffff));
    spec.outputs.forEach((o) => tx.addOutput(Buffer.from(o.scriptHex, 'hex'), o.sats));
    extraOuts.forEach((o) => tx.addOutput(Buffer.from(o.scriptHex, 'hex'), o.sats));
    const rawtx = tx.toHex();
    const inputs = [
        { txid: fx.COMMIT_TXID, vout: 0, amount: 2, redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.MS_PSBT, confirmations: 1 },
        { txid: fx.FUND_TXID, vout: 1, amount: fundSats / fx.LTC, pubkey: fx.BUYER_PUB, scriptPubKey: fx.SPK.B, confirmations: 1 },
    ];
    const built = relayerUtil.buildPsbt({ rawtx, inputs, network: 'LTC' });
    if (built.error) throw new Error(`relayer buildPsbt: ${built.error}`);
    return { psbtHex: built.data, decoded: decodeLikeCore(built.data), spec };
};

// Runs the seller's step 4 with a given validated/returned PSBT and the given node overrides.
const runStep4 = async (sid, decoded, { over = {} } = {}) => {
    const { sw, sock, state } = await sellerAtStep3(sid, { over });
    const psbtHex = hx(`P6-${sid.slice(0, 8)}`);
    state.psbts[psbtHex] = decoded;
    inbound(sock, sid, 'BUYER:STEP4', psbtHex);
    const res = await settle(sw);
    return { res, sock, state, psbtHex };
};

const overValidate = (map) => (params) => {
    const script = map[params[0]];
    return script ? { data: { isvalid: true, scriptPubKey: script } } : { data: { isvalid: false } };
};

test('R6: the relayer-built BIP49 buyer PSBT is accepted and signed once (the round-5 guard refused it)', async () => {
    const S = 'd6'.repeat(32);
    const { psbtHex, decoded, spec } = relayerTradePsbt();
    // The decode of the relayer PSBT carries the same script forms the fixture models.
    assert.strictEqual(decoded.inputs[1].witness_utxo.scriptPubKey.hex, fx.SPK.WPKH_B, 'builder buyer witness form');
    assert.strictEqual(decoded.inputs[0].witness_utxo.scriptPubKey.hex, fx.SPK.MS_PSBT, 'builder commit witness form');
    assert.deepStrictEqual(decoded.tx.vout.map((o) => o.scriptPubKey.hex), spec.outputs.map((o) => o.scriptHex));
    const { sw, sock, state } = await sellerAtStep3(S);
    state.psbts[psbtHex] = decoded;
    inbound(sock, S, 'BUYER:STEP4', psbtHex);
    await waitFor(() => sentNames(sock).includes('SELLER:STEP5'), { message: 'SELLER:STEP5 for the relayer PSBT' });
    assert.deepStrictEqual(state.calls.sign, [psbtHex]);
    inbound(sock, S, 'SERVER:STATE', { state: 'expired-unverified', txid: null }, null);
    await sw.ready;
});

test('R6: a bech32 (native P2WPKH) buyer with a P2WSH channel is accepted', async () => {
    const S = 'd7'.repeat(32);
    const sc = fx.scriptsFor({ buyerAddr: 'p2wpkh', channel: 'p2wsh' });
    const over = { validateaddress: overValidate({ 'S-ADDR': sc.S, 'B-ADDR': sc.B, 'MS-ADDR': sc.MS }) };
    const { sw, sock, state } = await sellerAtStep3(S, { over });
    state.psbts[P] = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC, buyerScript: sc.B, sellerScript: sc.S }));
    inbound(sock, S, 'BUYER:STEP4', P);
    await waitFor(() => sentNames(sock).includes('SELLER:STEP5'), { message: 'SELLER:STEP5 bech32 buyer' });
    inbound(sock, S, 'SERVER:STATE', { state: 'expired-unverified', txid: null }, null);
    await sw.ready;
});

test('R6: a channel the node reports as P2SH(P2WSH) with the builder P2WSH witness is accepted', async () => {
    const S = 'd8'.repeat(32);
    const sc = fx.scriptsFor({ buyerAddr: 'p2sh', channel: 'p2sh' });
    const over = { validateaddress: overValidate({ 'S-ADDR': sc.S, 'B-ADDR': sc.B, 'MS-ADDR': sc.MS }) };
    const { sw, sock, state } = await sellerAtStep3(S, { over });
    state.psbts[P] = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC }));
    inbound(sock, S, 'BUYER:STEP4', P);
    await waitFor(() => sentNames(sock).includes('SELLER:STEP5'), { message: 'SELLER:STEP5 P2SH channel' });
    inbound(sock, S, 'SERVER:STATE', { state: 'expired-unverified', txid: null }, null);
    await sw.ready;
});

test('R6: a buyer input that claims the seller key-derived script (P2WPKH of the seller key) is refused, nothing signed', async () => {
    const s = fx.honestSpec({ fundSats: 3 * fx.LTC });
    s.inputs[1].scriptHex = fx.SPK.WPKH_S;
    await expectRefused('e1'.repeat(32), fx.decodedFrom(s), /input 1 is not at the buyer's address/);
});

test('R6: a buyer input that claims the seller address script (P2SH of the seller key) is refused, nothing signed', async () => {
    const s = fx.honestSpec({ fundSats: 3 * fx.LTC });
    s.inputs[1].scriptHex = fx.SPK.S;
    await expectRefused('e2'.repeat(32), fx.decodedFrom(s), /input 1 is not at the buyer's address/);
});

test('R6: a buyer address not derived from the buyer key is refused before the PSBT is read', async () => {
    const wrong = fx.p2shOf(fx.wpkh(fx.OTHER_PUB));
    const over = { validateaddress: overValidate({ 'S-ADDR': fx.SPK.S, 'B-ADDR': wrong, 'MS-ADDR': fx.SPK.MS }) };
    const { sw, sock, state } = await sellerAtStep3('e3'.repeat(32), { over });
    state.psbts[P] = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC, buyerScript: wrong }));
    inbound(sock, 'e3'.repeat(32), 'BUYER:STEP4', P);
    const res = await settle(sw);
    assert.match(String(res.reason), /buyer address is not derived from the buyer key/);
    assert.strictEqual(state.calls.sign.length, 0);
    assert.ok(!sentNames(sock).includes('SELLER:STEP5'));
});

test('R6: a commit input whose witness script is not this channel redeem script is refused', async () => {
    const s = fx.honestSpec({ fundSats: 3 * fx.LTC });
    const other = fx.p2wshOf('51' + '21' + fx.SELLER_PUB.slice(2) + '51ae'); // a different script
    s.inputs[0].scriptHex = other;
    await expectRefused('e4'.repeat(32), fx.decodedFrom(s), /commit input does not match/);
});

test('R6: a channel address that is not the 2-of-2 of this swap is refused before the PSBT is read', async () => {
    const forged = fx.p2wshOf('52' + '21' + fx.BUYER_PUB.slice(2) + '21' + fx.OTHER_PUB.slice(2) + '52ae');
    const over = { validateaddress: overValidate({ 'S-ADDR': fx.SPK.S, 'B-ADDR': fx.SPK.B, 'MS-ADDR': forged }) };
    const { sw, sock, state } = await sellerAtStep3('e5'.repeat(32), { over });
    state.psbts[P] = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC }));
    inbound(sock, 'e5'.repeat(32), 'BUYER:STEP4', P);
    const res = await settle(sw);
    assert.match(String(res.reason), /channel address is not the 2-of-2 of this swap/);
    assert.strictEqual(state.calls.sign.length, 0);
});

test('R6: a PSBT input with sighash NONE|ANYONECANPAY on the commit is refused, nothing signed', async () => {
    const d = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC }));
    d.inputs[0].sighash = 'NONE|ANYONECANPAY';
    await expectRefused('e6'.repeat(32), d, /sighash is NONE\|ANYONECANPAY, only ALL is signed/);
});

test('R6: a PSBT input with sighash SINGLE|ANYONECANPAY on a buyer input is refused, nothing signed', async () => {
    const d = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC }));
    d.inputs[1].sighash = 'SINGLE|ANYONECANPAY';
    await expectRefused('e7'.repeat(32), d, /input 1 sighash is SINGLE\|ANYONECANPAY/);
});

test('R6: an explicit sighash ALL is accepted', async () => {
    const d = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC }));
    d.inputs[0].sighash = 'ALL';
    d.inputs[1].sighash = 'ALL';
    assert.doesNotThrow(() => assertPsbtMatchesTrade(d, fx.expectation()));
});

test('R6: an input that already carries a signature is refused, nothing signed', async () => {
    const d = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC }));
    d.inputs[1].partial_signatures = { [fx.BUYER_PUB]: '3044' + '01' };
    await expectRefused('e8'.repeat(32), d, /input 1 already carries a signature/);
});

test('R6: an input that is already finalized is refused, nothing signed', async () => {
    const d = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC }));
    d.inputs[1].final_scriptSig = '16001400';
    await expectRefused('e9'.repeat(32), d, /input 1 is already finalized/);
});

test('R6: the seller signature is missing after signing: no SELLER:STEP5, the swap terminates', async () => {
    const { sw, sock, state } = await sellerAtStep3('f1'.repeat(32));
    state.psbts[P] = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC }));
    // signPsbt returns a PSBT with no partial signature on the commit input.
    sw.txsService.signPsbt = async ({ psbtHex }) => {
        state.calls.sign.push(psbtHex);
        state.psbts[`SIGNED:${psbtHex}`] = state.psbts[psbtHex];
        return { data: { psbtHex: `SIGNED:${psbtHex}`, isFinished: false } };
    };
    inbound(sock, 'f1'.repeat(32), 'BUYER:STEP4', P);
    const res = await settle(sw);
    assert.match(String(res.reason), /seller signature missing on the commit input/);
    assert.ok(!sentNames(sock).includes('SELLER:STEP5'), 'SELLER:STEP5 sent without the seller signature');
    assert.deepStrictEqual(sentNames(sock).slice(-1), ['TERMINATE_TRADE']);
});

test('R6: a signed PSBT that is a different transaction is refused, nothing returned', async () => {
    const { sw, sock, state } = await sellerAtStep3('f2'.repeat(32));
    state.psbts[P] = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC }));
    sw.txsService.signPsbt = async ({ psbtHex }) => {
        state.calls.sign.push(psbtHex);
        const other = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC, sellerSats: fx.LTC + 1 }), { txid: 'b'.repeat(64) });
        state.psbts[`SIGNED:${psbtHex}`] = fx.withSellerSignature(other);
        return { data: { psbtHex: `SIGNED:${psbtHex}`, isFinished: false } };
    };
    inbound(sock, 'f2'.repeat(32), 'BUYER:STEP4', P);
    const res = await settle(sw);
    assert.match(String(res.reason), /signed PSBT is a different transaction/);
    assert.ok(!sentNames(sock).includes('SELLER:STEP5'));
});

test('R6: a seller signature added to a buyer input is refused, nothing returned', async () => {
    const { sw, sock, state } = await sellerAtStep3('f3'.repeat(32));
    state.psbts[P] = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC }));
    sw.txsService.signPsbt = async ({ psbtHex }) => {
        state.calls.sign.push(psbtHex);
        const d = fx.withSellerSignature(state.psbts[psbtHex], 0);
        d.inputs[1].partial_signatures = { [fx.SELLER_PUB]: '3044' + '01' };
        state.psbts[`SIGNED:${psbtHex}`] = d;
        return { data: { psbtHex: `SIGNED:${psbtHex}`, isFinished: false } };
    };
    inbound(sock, 'f3'.repeat(32), 'BUYER:STEP4', P);
    const res = await settle(sw);
    assert.match(String(res.reason), /seller signature added to input 1/);
    assert.ok(!sentNames(sock).includes('SELLER:STEP5'));
});

test('R6: the step 4 refusal tells the user which commit output is stranded in the channel', async () => {
    const d = fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC, sellerSats: fx.LTC + 1 }));
    const { res } = await runStep4('f4'.repeat(32), d);
    assert.match(String(res.reason), /^Step 4: /);
    assert.match(String(res.reason), new RegExp(`Commit output ${fx.COMMIT_TXID}:0 is in the 2-of-2 channel; spending it needs the buyer's signature\\.`));
});

// ---- attack matrix on the validator (direct) -----------------------------------------
const matrix = (name, mutate, re, opts = {}) => test(`R6 matrix: ${name}`, async () => {
    const base = opts.base ?? fx.honestSpec({ fundSats: 3 * fx.LTC });
    const s = JSON.parse(JSON.stringify(base));
    const decoded = fx.decodedFrom(s);
    mutate(decoded, s);
    const exp = opts.expectation ? opts.expectation() : fx.expectation();
    if (re === null) {
        assert.doesNotThrow(() => assertPsbtMatchesTrade(decoded, exp));
    } else {
        assert.throws(() => assertPsbtMatchesTrade(decoded, exp), re);
    }
});
const honestFundedDecoded = () => fx.decodedFrom(fx.honestSpec({ fundSats: 3 * fx.LTC }));
const outScriptAt = (d, i) => d.tx.vout[i].scriptPubKey;

matrix('honest BIP49 transaction (control)', () => {}, null);
matrix('duplicate buyer output splitting the change (sum equal)', (d) => {
    const v = d.tx.vout[0].value;
    const half = Math.floor(v / 2 * fx.LTC) / fx.LTC;
    d.tx.vout[0].value = half;
    d.tx.vout.splice(1, 0, { value: v - half, n: 1, scriptPubKey: { hex: fx.SPK.B } });
    d.tx.vout.forEach((o, n) => { o.n = n; });
}, /buyer output is|output set differs/);
matrix('extra zero-value output to the seller script', (d) => {
    d.tx.vout.push({ value: 0, n: 3, scriptPubKey: { hex: fx.SPK.S } });
}, /seller output is|output set differs/);
matrix('extra zero-value output to the buyer script', (d) => {
    d.tx.vout.push({ value: 0, n: 3, scriptPubKey: { hex: fx.SPK.B } });
}, /buyer output is|output set differs/);
matrix('second OP_RETURN with zero value', (d) => {
    d.tx.vout.push({ value: 0, n: 3, scriptPubKey: { hex: '6a0161' } });
}, /output set differs|not one of/);
matrix('OP_RETURN with the same payload in OP_PUSHDATA1 encoding', (d) => {
    const payload = fx.payloadFor(fx.EXPIRY);
    d.tx.vout[2].scriptPubKey.hex = '6a4c' + payload.length.toString(16).padStart(2, '0') + Buffer.from(payload).toString('hex');
}, /not one of the expected outputs/);
matrix('OP_RETURN with an extra trailing push', (d) => {
    d.tx.vout[2].scriptPubKey.hex += '0100';
}, /not one of the expected outputs/);
matrix('OP_RETURN with a payload for a different amount', (d) => {
    d.tx.vout[2].scriptPubKey.hex = fx.opReturnFor(fx.payloadFor(fx.EXPIRY, { amountDesired: '2' }));
}, /not one of the expected outputs/);
matrix('OP_RETURN that carries 1 sat', (d) => { d.tx.vout[2].value = 1 / fx.LTC; }, /OP_RETURN output carries value/);
matrix('uppercase hex for the seller script is the same script (accepted)', (d) => {
    d.tx.vout[1].scriptPubKey.hex = d.tx.vout[1].scriptPubKey.hex.toUpperCase();
}, null);
matrix('seller script with witness version 1 and the same program is refused', (d) => {
    d.tx.vout[1].scriptPubKey.hex = '51' + d.tx.vout[1].scriptPubKey.hex.slice(2);
}, /not one of the expected outputs/, { base: fx.honestSpec({ fundSats: 3 * fx.LTC }) });
matrix('seller output one sat less, buyer gains it', (d) => { d.tx.vout[1].value -= 1 / fx.LTC; }, /seller output is/);
matrix('buyer change one sat more', (d) => { d.tx.vout[0].value += 1 / fx.LTC; }, /buyer output is/);
matrix('value as a string', (d) => { d.tx.vout[1].value = '1.00000000'; }, /not a non-negative number/);
matrix('value NaN', (d) => { d.tx.vout[1].value = NaN; }, /not a non-negative number/);
matrix('value Infinity', (d) => { d.tx.vout[1].value = Infinity; }, /not a non-negative number/);
matrix('value negative', (d) => { d.tx.vout[0].value = -1; }, /not a non-negative number/);
matrix('value with a fractional satoshi', (d) => { d.tx.vout[1].value = 1 + 1e-9; }, /not a whole number of satoshis/);
matrix('value far beyond the safe integer range', (d) => { d.tx.vout[1].value = 1e300; }, /not a whole number of satoshis/);
matrix('input amount as a string', (d) => { d.inputs[1].witness_utxo.amount = '3'; }, /not a non-negative number/);
matrix('commit outpoint listed twice', (d, s) => {
    d.tx.vin.push({ ...d.tx.vin[0] });
    d.inputs.push(JSON.parse(JSON.stringify(d.inputs[0])));
}, /repeats an earlier input/);
matrix('buyer input at the seller address, witness claimed as the seller key script', (d) => {
    d.inputs[1].witness_utxo.scriptPubKey.hex = fx.SPK.WPKH_S;
}, /not at the buyer's address/);
matrix('buyer input with the seller P2SH script', (d) => {
    d.inputs[1].witness_utxo.scriptPubKey.hex = fx.SPK.S;
}, /not at the buyer's address/);
matrix('buyer input with an unrelated script', (d) => {
    d.inputs[1].witness_utxo.scriptPubKey.hex = fx.SPK.OTHER;
}, /not at the buyer's address/);
matrix('input without witness_utxo (legacy-only record)', (d) => {
    delete d.inputs[1].witness_utxo;
}, /witness_utxo missing/);
matrix('nonzero locktime', (d) => { d.tx.locktime = 500000; }, /locktime/);
matrix('sighash NONE on the commit', (d) => { d.inputs[0].sighash = 'NONE'; }, /sighash is NONE/);
matrix('sighash absent is treated as ALL (control)', (d) => { delete d.inputs[0].sighash; }, null);
matrix('partial signature from the buyer already on the buyer input', (d) => {
    d.inputs[1].partial_signatures = { [fx.BUYER_PUB]: '30' };
}, /already carries a signature/);
matrix('empty partial_signatures object is accepted (control)', (d) => {
    d.inputs[1].partial_signatures = {};
}, null);
matrix('buyer change one sat less (fee one sat above the agreed fee)', (d) => { d.tx.vout[0].value -= 1 / fx.LTC; }, /buyer output is/);
matrix('single buyer output (change omitted), value to the seller', (d) => {
    d.tx.vout.splice(0, 1);
    d.tx.vout.forEach((o, n) => { o.n = n; });
}, /output set differs|not one of|output 0 is not/);
matrix('seller key equals buyer key', () => {}, /seller and buyer keys are the same/, {
    expectation: () => ({ ...fx.expectation(), buyerPubkeyHex: fx.SELLER_PUB }),
});
matrix('commit redeem script the node channel does not commit to', () => {}, /channel address is not the 2-of-2/, {
    expectation: () => ({ ...fx.expectation(), commitRedeemScriptHex: '5121' + fx.OTHER_PUB.slice(2) + '51ae' }),
});
test('R6 matrix: the validator returns the txid and the commit index for a valid PSBT', async () => {
    const r = assertPsbtMatchesTrade(honestFundedDecoded(), fx.expectation());
    assert.strictEqual(r.commitIndex, 0);
    assert.strictEqual(r.txid, fx.TXID);
});

matrix('seller address script not derived from the seller key', () => {}, /seller address is not derived from the seller key/, {
    expectation: () => ({ ...fx.expectation(), sellerScriptHex: fx.SPK.OTHER }),
});


test('R6: a relayer-built PSBT with two buyer inputs (fee 60000 sat per input) is accepted and signed once', async () => {
    const S = 'd9'.repeat(32);
    const LTC = fx.LTC;
    const e2txid = 'e'.repeat(64);
    const tx = new bitcoinR6.Transaction();
    tx.version = 2;
    tx.addInput(Buffer.from(fx.COMMIT_TXID, 'hex').reverse(), 0, 0xffffffff);
    tx.addInput(Buffer.from(fx.FUND_TXID, 'hex').reverse(), 1, 0xffffffff);
    tx.addInput(Buffer.from(e2txid, 'hex').reverse(), 2, 0xffffffff);
    const fee = 3 * fx.FEE_PER_INPUT;
    const buyerSats = 2 * LTC + 1.5 * LTC + 2 * LTC - LTC - fee;
    tx.addOutput(Buffer.from(fx.SPK.B, 'hex'), buyerSats);
    tx.addOutput(Buffer.from(fx.SPK.S, 'hex'), LTC);
    tx.addOutput(Buffer.from(fx.opReturnFor(fx.payloadFor(fx.EXPIRY)), 'hex'), 0);
    const inputs = [
        { txid: fx.COMMIT_TXID, vout: 0, amount: 2, redeemScript: fx.REDEEM, scriptPubKey: fx.SPK.MS_PSBT, confirmations: 1 },
        { txid: fx.FUND_TXID, vout: 1, amount: 1.5, pubkey: fx.BUYER_PUB, scriptPubKey: fx.SPK.B, confirmations: 1 },
        { txid: e2txid, vout: 2, amount: 2, pubkey: fx.BUYER_PUB, scriptPubKey: fx.SPK.B, confirmations: 1 },
    ];
    const built = relayerUtil.buildPsbt({ rawtx: tx.toHex(), inputs, network: 'LTC' });
    assert.ok(!built.error, built.error);
    const decoded = decodeLikeCore(built.data);
    const { sw, sock, state } = await sellerAtStep3(S);
    state.psbts[P] = decoded;
    inbound(sock, S, 'BUYER:STEP4', P);
    await waitFor(() => sentNames(sock).includes('SELLER:STEP5'), { message: 'SELLER:STEP5 two buyer inputs' });
    assert.deepStrictEqual(state.calls.sign, [P]);
    inbound(sock, S, 'SERVER:STATE', { state: 'expired-unverified', txid: null }, null);
    await sw.ready;
});

matrix('relative timelock on a buyer input (sequence 0x0000ffff) is refused', (d) => {
    d.tx.vin[1].sequence = 0x0000ffff;
}, /input 1 carries a relative timelock/);
matrix('relative timelock on the commit input is refused', (d) => {
    d.tx.vin[0].sequence = 0x00000010;
}, /input 0 carries a relative timelock/);
matrix('sequence 0xfffffffd (RBF signalling, no relative lock) is accepted (control)', (d) => {
    d.tx.vin[1].sequence = 0xfffffffd;
}, null);
matrix('sequence 0xfffffffe (locktime-enabled, no relative lock) is accepted (control)', (d) => {
    d.tx.vin[0].sequence = 0xfffffffe;
}, null);
matrix('sequence above 32 bits is refused', (d) => { d.tx.vin[1].sequence = 0x1ffffffff; }, /is not a sequence number/);
