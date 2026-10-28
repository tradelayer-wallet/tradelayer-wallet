'use strict';

// Max must never ask for an amount the orderbook refuses. The orderbook settles a spot match only when
// amountUnits * priceSats / UNIT_SCALE is a whole number of satoshis (tl-orderbook-server
// src/services/orderbook/orderbook.class.ts:376-381). The repos do not load each other, so that rule is
// copied here from tl-orderbook-server src/utils/pure/units.ts:9-35 (mulDigitStrings and valueSats), with
// the same line order, and is the validator these tests run against.

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadTs, REPO } = require('../support/ts-loader');

const units = loadTs(path.join(REPO, 'packages', 'wallet-fe', 'src', 'app', 'utils', 'units.ts')).exports;

// tl-orderbook-server src/utils/pure/units.ts:9-24
const mulDigitStrings = (x, y) => {
    const xs = x.split('').reverse().map(Number);
    const ys = y.split('').reverse().map(Number);
    const out = [];
    for (let k = 0; k < xs.length + ys.length; k++) out.push(0);
    for (let i = 0; i < xs.length; i++) {
        for (let j = 0; j < ys.length; j++) out[i + j] += xs[i] * ys[j];
    }
    for (let k = 0; k < out.length - 1; k++) {
        out[k + 1] += Math.floor(out[k] / 10);
        out[k] = out[k] % 10;
    }
    return out.reverse().join('').replace(/^0+(?=\d)/, '');
};

// tl-orderbook-server src/utils/pure/units.ts:28-35 (the input guard at :29 is applied by the caller here)
const orderbookValueSats = (amountUnits, priceSats) => {
    const product = mulDigitStrings(String(amountUnits), String(priceSats));
    if (product === '0') return 0;
    if (product.length <= 8 || !/^0{8}$/.test(product.slice(-8))) return null;
    const quotient = Number(product.slice(0, -8));
    return Number.isSafeInteger(quotient) ? quotient : null;
};

test('largestSettleableAmount is the largest amount at or below the maximum whose value is whole satoshis', () => {
    const cases = [
        [1428485714, 70000000, 1428485710], // price 0.7: amounts must be multiples of 10
        [1428571428, 70000000, 1428571420],
        [1000000001, 50000000, 1000000000], // price 0.5: multiples of 2
        [987654321, 12345678, 950000000], // price 0.12345678: multiples of 5e7
        [250000000, 100000000, 250000000], // price 1: every amount settles
        [250000000, 1, 200000000], // price 1 sat: only whole tokens settle
        [123456789, 87654321, 100000000], // price coprime with 1e8: only whole tokens settle
        [9007199254740991, 70000000, 9007199254740990], // the top of the safe range is exact
        [9007199254740991, 100000000, 9007199254740991],
        [1234, 0, 1234], // a zero price has value 0 for any amount
        [5, 1, 0], // below one step
        [0, 70000000, 0],
    ];
    for (const [maxUnits, priceUnits, expect] of cases) {
        assert.equal(units.largestSettleableAmount(maxUnits, priceUnits), expect, `largestSettleableAmount(${maxUnits}, ${priceUnits})`);
    }
});

test('largestSettleableAmount is accepted by the orderbook validator, and nothing larger at or below the maximum is', () => {
    let state = 0x9e3779b9;
    const next = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    const prices = [70000000, 50000000, 30000000, 12345678, 1, 100000000, 87654321, 1234, 0, 10000000, 3];
    for (let i = 0; i < 1000; i++) {
        const priceUnits = i < prices.length ? prices[i] : next() % 200000000;
        const maxUnits = i % 3 === 0 ? next() % 3000 : (next() * 4096 + next()) % 2000000000;
        const r = units.largestSettleableAmount(maxUnits, priceUnits);
        const label = `largestSettleableAmount(${maxUnits}, ${priceUnits}) = ${r}`;
        assert.ok(r <= maxUnits, label);
        assert.notEqual(orderbookValueSats(r, priceUnits), null, `${label} is refused by the orderbook`);
        for (let x = r + 1; x <= Math.min(maxUnits, r + 200); x++) {
            assert.equal(orderbookValueSats(x, priceUnits), null, `${label}, but ${x} is also settleable`);
        }
    }
});

test('largestSettleableAmount refuses values that are not wire units', () => {
    assert.throws(() => units.largestSettleableAmount(1.5, 70000000), /not a quantity in units/);
    assert.throws(() => units.largestSettleableAmount(10, '70000000'), /not a quantity in units/);
});
