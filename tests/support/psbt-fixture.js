'use strict';

/*
 * PSBT fixtures for the seller's pre-sign check (offline).
 *
 * Shapes follow Bitcoin Core / Litecoin Core decodepsbt: tx.vin / tx.vout with
 * LTC float values, and inputs[i].witness_utxo { amount, scriptPubKey.hex }. Amounts
 * are satoshis here and converted to LTC floats the way decodepsbt prints them.
 * The honest transaction follows tx-builder.service.ts buildLTCInstatTx: the commit
 * output first, then the buyer's own UTXOs; outputs buyer change, seller, OP_RETURN;
 * fee 60000 sat per input; change = inputs - seller - fee.
 *
 * Round 6: the keys and scripts are real. Trading addresses are BIP49 (auth.service
 * m/49): P2SH(P2WPKH(key)). The relayer PSBT builder (wallet-server crypto.util buildPsbt)
 * writes every buyer UTXO's witness script as P2WPKH(key) and the commit as P2WSH(redeem),
 * so the PSBT form and the address form differ, as they do on the wire. Scripts are derived
 * with bitcoinjs-lib, not with the guard's own code, so the guard's hashing is cross-checked.
 */

const path = require('path');
const ROOT_NODE = path.join(__dirname, '..', '..', 'node_modules');
const bitcoin = require(path.join(ROOT_NODE, 'bitcoinjs-lib'));
const ECPair = require(path.join(ROOT_NODE, 'ecpair')).ECPairFactory(require(path.join(ROOT_NODE, 'tiny-secp256k1')));
const { payments } = bitcoin;

const LTC = 100000000;
const FEE_PER_INPUT = 60000;
const DUST = 3600;
const TIP = 1000;
const EXPIRY = TIP + 100; // buyer's tip + 100, as buyer.ts sets it
const TXID = 'a'.repeat(64); // unsigned transaction id the buyer records
const COMMIT_TXID = 'c'.repeat(64);
const FUND_TXID = 'd'.repeat(64);

const pubOf = (n) => ECPair.fromPrivateKey(Buffer.alloc(32, n)).publicKey.toString('hex');
const SELLER_PUB = pubOf(1);
const BUYER_PUB = pubOf(2);
const OTHER_PUB = pubOf(3);
const buf = (hex) => Buffer.from(hex, 'hex');
const hex = (b) => b.toString('hex');

const wpkh = (pub) => hex(payments.p2wpkh({ pubkey: buf(pub) }).output); // 0014<h160>
const p2shOf = (script) => hex(payments.p2sh({ redeem: { output: buf(script) } }).output); // a914<h160>87
const p2wshOf = (script) => hex(payments.p2wsh({ redeem: { output: buf(script) } }).output); // 0020<sha256>
const REDEEM = hex(payments.p2ms({ m: 2, pubkeys: [buf(SELLER_PUB), buf(BUYER_PUB)] }).output); // 2-of-2 channel

// Forms of the scripts. `buyerAddr` and `channel` are what the node reports for the addresses:
// BIP49 (P2SH-wrapped) is the wallet's trading form; bech32 is the native form.
const scriptsFor = ({ buyerAddr = 'p2sh', channel = 'p2wsh', sellerAddr = 'p2sh' } = {}) => {
    const addr = (pub, form) => (form === 'p2sh' ? p2shOf(wpkh(pub)) : wpkh(pub));
    return {
        S: addr(SELLER_PUB, sellerAddr), // seller address (change-free: receives sellerSats)
        B: addr(BUYER_PUB, buyerAddr), // buyer address (receives change)
        MS: channel === 'p2sh' ? p2shOf(p2wshOf(REDEEM)) : p2wshOf(REDEEM), // channel output as the node reports it
    };
};

const SPK = {
    ...scriptsFor(),
    // What the relayer PSBT builder writes for buyer UTXOs and the commit (fixed, whatever the address).
    WPKH_B: wpkh(BUYER_PUB),
    WPKH_S: wpkh(SELLER_PUB),
    MS_PSBT: p2wshOf(REDEEM),
    OTHER: '0014' + '44'.repeat(20), // any other address
};
const ADDR = { 'S-ADDR': SPK.S, 'B-ADDR': SPK.B, 'MS-ADDR': SPK.MS };

// TL payload for the LTC-for-tokens trade. Stands in for tl_createpayload_instant_ltc_trade.
const payloadFor = (expiry, { prop = 11, amountDesired = '1', price = '1' } = {}) =>
    `PAY:${prop},${amountDesired},${price},${expiry}`;
const toHex = (s) => Buffer.from(s, 'utf8').toString('hex');
// OP_RETURN scriptPubKey carrying the payload (single-byte push, payload < 76 bytes).
const opReturnFor = (payload) => '6a' + payload.length.toString(16).padStart(2, '0') + toHex(payload);

const ltc = (sats) => sats / LTC;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// The honest unsigned transaction, as the builder would produce it.
// `buyerScript` / `sellerScript` are the address scripts the outputs pay to.
const honestSpec = (o = {}) => {
    const { commitSats = 2 * LTC, fundSats = 0, sellerSats = LTC, expiry = EXPIRY, payload } = o;
    const sellerScript = o.sellerScript ?? SPK.S;
    const buyerScript = o.buyerScript ?? SPK.B;
    const inputs = [{ txid: COMMIT_TXID, vout: 0, sats: commitSats, scriptHex: SPK.MS_PSBT }];
    if (fundSats) inputs.push({ txid: FUND_TXID, vout: 1, sats: fundSats, scriptHex: SPK.WPKH_B });
    const fee = FEE_PER_INPUT * inputs.length;
    const buyerSats = commitSats + fundSats - sellerSats - fee;
    return {
        inputs,
        outputs: [
            { sats: buyerSats, scriptHex: buyerScript },
            { sats: sellerSats, scriptHex: sellerScript },
            { sats: 0, scriptHex: opReturnFor(payload ?? payloadFor(expiry)) },
        ],
        locktime: 0,
    };
};

// decodepsbt result for a transaction spec.
const decodedFrom = (spec, { txid = TXID } = {}) => ({
    tx: {
        txid,
        version: 2,
        locktime: spec.locktime ?? 0,
        vin: spec.inputs.map((i) => ({ txid: i.txid, vout: i.vout, sequence: 4294967295, scriptSig: { asm: '', hex: '' } })),
        vout: spec.outputs.map((o, n) => ({ value: ltc(o.sats), n, scriptPubKey: { asm: '', hex: o.scriptHex, type: 'unknown' } })),
    },
    inputs: spec.inputs.map((i) => ({ witness_utxo: { amount: ltc(i.sats), scriptPubKey: { hex: i.scriptHex } } })),
});

// What the seller's rebuilt expectation looks like for the default trade.
const expectation = (o = {}) => ({
    sellerScriptHex: o.sellerScript ?? SPK.S,
    buyerScriptHex: o.buyerScript ?? SPK.B,
    sellerSats: o.sellerSats ?? LTC,
    dustSats: DUST,
    commit: { txid: COMMIT_TXID, vout: 0, sats: o.commitSats ?? 2 * LTC, scriptHex: o.channelScript ?? SPK.MS },
    opReturnScriptHexes: range(EXPIRY - 6, EXPIRY + 6).map((e) => opReturnFor(payloadFor(e))),
    sellerPubkeyHex: SELLER_PUB,
    buyerPubkeyHex: BUYER_PUB,
    commitRedeemScriptHex: REDEEM,
});

// A decodepsbt result after the seller signed: the commit input carries the seller's signature.
const withSellerSignature = (decoded, commitIndex = 0, pub = SELLER_PUB) => {
    const out = JSON.parse(JSON.stringify(decoded));
    out.inputs[commitIndex].partial_signatures = { [pub]: '3044' + '02'.repeat(34) + '01' };
    return out;
};

module.exports = {
    LTC, FEE_PER_INPUT, DUST, TIP, EXPIRY, TXID, COMMIT_TXID, FUND_TXID, SPK, ADDR,
    SELLER_PUB, BUYER_PUB, OTHER_PUB, REDEEM, scriptsFor, wpkh, p2shOf, p2wshOf,
    payloadFor, opReturnFor, honestSpec, decodedFrom, expectation, withSellerSignature, range,
};
