'use strict';

// PSBT signing in the wallet server. The signer must sign only SIGHASH_ALL: an input whose
// sighash type (taken from the PSBT, which a counterparty supplies) is NONE or SINGLE must
// stay unsigned, so the signature cannot authorize a different transaction.

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const bitcoin = require('bitcoinjs-lib');
const ecpair = require('ecpair');
const ecc = require('tiny-secp256k1');
const { loadTs, REPO } = require('../support/ts-loader');

const SERVER_SRC = path.join(REPO, 'packages', 'wallet-server', 'src');
const { signPsbtRawtTx } = loadTs(path.join(SERVER_SRC, 'utils', 'crypto.util.ts')).exports;
const { networks } = loadTs(path.join(SERVER_SRC, 'utils', 'networks.ts')).exports;

const ECPair = ecpair.ECPairFactory(ecc);
const key = ECPair.fromPrivateKey(Buffer.alloc(32, 7), { network: networks.LTC });
const wif = key.toWIF();
const script = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key.publicKey) }).output;

// One P2WPKH input the key owns, one output. The test sets the input's sighash type.
const buildPsbt = (sighashType) => {
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: Buffer.alloc(32, 1), index: 0, witnessUtxo: { script, value: 100000 } });
    psbt.addOutput({ script: Buffer.from(`0014${'22'.repeat(20)}`, 'hex'), value: 90000 });
    if (sighashType !== undefined) psbt.updateInput(0, { sighashType });
    return psbt.toHex();
};

const signed = (psbtHex) => signPsbtRawtTx({ wif, network: 'LTC', psbtHex });

test('an input with the default sighash (ALL) is signed and finalized', () => {
    const res = signed(buildPsbt());
    assert.equal(res.error, undefined);
    assert.equal(res.data.isFinished, true);
    assert.ok(res.data.finalHex);
    const out = bitcoin.Psbt.fromHex(res.data.psbtHex);
    assert.equal(out.data.inputs[0].partialSig.length, 1);
});

test('an explicit SIGHASH_ALL is signed', () => {
    const res = signed(buildPsbt(0x01));
    assert.equal(res.data.isFinished, true);
});

// bitcoinjs refuses a sighash type outside its whitelist (SIGHASH_ALL), so the input is not
// signed. The signer reports that as an error (no signature was produced) or as an unfinished PSBT.
// Either way there is no finalized transaction and no partial signature on the input.
for (const [name, type] of [['NONE', 0x02], ['SINGLE', 0x03], ['NONE|ANYONECANPAY', 0x82], ['SINGLE|ANYONECANPAY', 0x83]]) {
    test(`an input that asks for SIGHASH_${name} is left unsigned and not finalized`, () => {
        const res = signed(buildPsbt(type));
        assert.ok(res.error || res.data.isFinished === false, 'a non-ALL input produced a finished transaction');
        assert.equal(res.data?.finalHex, undefined);
        if (res.data) {
            const out = bitcoin.Psbt.fromHex(res.data.psbtHex);
            assert.equal(out.data.inputs[0].partialSig, undefined, `signed with sighash ${type}`);
        }
    });
}
