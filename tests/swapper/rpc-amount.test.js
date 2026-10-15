'use strict';

// Amounts the swap sends to the TradeLayer RPC are decimal strings with at most 8 places. A JS
// number's toString() uses exponent form below 1e-6 ("5e-7"), so every amount argument goes through
// rpcAmount. The source scan fails if an amount is passed through toString() again.

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadTs, REPO } = require('../support/ts-loader');

const SWAPPER_DIR = path.join(REPO, 'packages', 'wallet-fe', 'src', 'app', 'utils', 'swapper');
const { rpcAmount } = loadTs(path.join(SWAPPER_DIR, 'common.ts')).exports;

test('rpcAmount writes small amounts in decimal, not exponent form', () => {
    assert.equal(rpcAmount(5e-7), '0.0000005');
    assert.equal(rpcAmount(1e-8), '0.00000001');
    assert.equal(rpcAmount(0.000001), '0.000001');
});

test('rpcAmount drops trailing zeros and keeps whole numbers whole', () => {
    assert.equal(rpcAmount(1), '1');
    assert.equal(rpcAmount(10), '10');
    assert.equal(rpcAmount(100.5), '100.5');
    assert.equal(rpcAmount(0), '0');
    assert.equal(rpcAmount(0.1 + 0.2), '0.3');
});

test('no swap amount is sent through toString()', () => {
    for (const file of ['buyer.ts', 'seller.ts']) {
        const source = fs.readFileSync(path.join(SWAPPER_DIR, file), 'utf8');
        assert.doesNotMatch(source, /(amount\w*|price)\)?\.toString\(\)/, `${file} sends an amount with toString()`);
    }
});
