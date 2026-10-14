'use strict';

// The orderbook server refuses an amount or price that is not a whole number of 1e-8 units
// (tl-orderbook-server src/utils/pure/mix.pure.ts toUnits). Every outbound order must pass that
// check, so these tests use the same rule. Runs against the real order-decimals.ts.

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadTs, REPO } = require('../support/ts-loader');

const { toOrderAmount, toOrderPrice, withOrderDecimals } = loadTs(
    path.join(REPO, 'packages', 'wallet-fe', 'src', 'app', 'utils', 'order-decimals.ts'),
).exports;

// The server's rule, copied from toUnits: the value must equal its own 1e-8 grid point.
const serverAccepts = (value) => {
    const units = Math.round(value * 1e8);
    return Number.isSafeInteger(units) && units / 1e8 === value;
};
// Exact units of a grid value, for cost checks without float error.
const unitsOf = (value) => BigInt(Math.round(value * 1e8));

test('float sums are rounded to the 1e-8 grid the server accepts', () => {
    const raw = 0.1 + 0.2; // 0.30000000000000004: refused by the server as sent
    assert.equal(serverAccepts(raw), false);
    assert.equal(toOrderAmount(raw), 0.3);
    assert.equal(toOrderPrice(raw, 'BUY'), 0.3);
    assert.equal(toOrderPrice(raw, 'SELL'), 0.3);
    assert.equal(serverAccepts(toOrderPrice(raw, 'SELL')), true);
});

test('binary noise just below a grid point does not drop a unit (7 * 0.3 is 2.1, not 2.09999999)', () => {
    const noisy = 7 * 0.3; // 2.0999999999999996
    assert.equal(toOrderAmount(noisy), 2.1);
    assert.equal(toOrderPrice(noisy, 'SELL'), 2.1);
});

test('the amount rounds DOWN: a value with more than 8 places never asks for more than typed', () => {
    assert.equal(toOrderAmount(0.123456789), 0.12345678);
    assert.equal(toOrderAmount('0.123456789'), 0.12345678);
    assert.equal(toOrderAmount(0.999999999), 0.99999999);
});

test('the price rounds against the typed limit: BUY down, SELL up', () => {
    assert.equal(toOrderPrice(0.123456789, 'BUY'), 0.12345678);
    assert.equal(toOrderPrice(0.123456789, 'SELL'), 0.12345679);
    assert.equal(toOrderPrice('0.123456789', 'SELL'), 0.12345679);
});

test('values already on the grid are unchanged', () => {
    for (const v of [0.1, 1.1, 0.00000001, 123.45678901, 2100000, 90000000]) {
        assert.equal(toOrderAmount(v), v);
        assert.equal(toOrderPrice(v, 'BUY'), v);
        assert.equal(toOrderPrice(v, 'SELL'), v);
        assert.equal(serverAccepts(toOrderAmount(v)), true);
    }
});

test('strings from the inputs are read as numbers, with surrounding spaces ignored', () => {
    assert.equal(toOrderAmount('1.5'), 1.5);
    assert.equal(toOrderAmount(' 1.5 '), 1.5);
    assert.equal(toOrderAmount('1e-8'), 0.00000001);
});

test('values that cannot be sent exactly throw instead of being sent with a different meaning', () => {
    // zero after rounding (1e-9 is below one unit), negative, NaN, infinity, empty, non-numeric
    for (const v of [1e-9, 0, -1, -0.5, NaN, Infinity, '', ' ', 'abc', '1,5']) {
        assert.throws(() => toOrderAmount(v), /must be a positive number|smaller than/, String(v));
    }
    for (const v of [0, -1, -0.5, NaN, Infinity, '', ' ', 'abc', '1,5']) {
        assert.throws(() => toOrderPrice(v, 'SELL'), /must be a positive number/, String(v));
    }
    // A SELL price below one unit rounds UP to one unit: it receives at least the typed limit.
    assert.equal(toOrderPrice(1e-9, 'SELL'), 0.00000001);
    assert.throws(() => toOrderPrice(1e-9, 'BUY'), /smaller than/);
    // beyond the safe integer range of 1e-8 units (about 9e7 in value): 1.2e8, 1e21
    assert.throws(() => toOrderAmount(123456789.123456789), /too large/);
    assert.throws(() => toOrderAmount(1e21), /too large/);
    assert.throws(() => toOrderPrice(1e21, 'BUY'), /too large/);
});

test('the largest sendable value is accepted', () => {
    // 16 significant digits do not fit a double near 9e7, so the largest typed value has 15.
    assert.equal(toOrderAmount(90071992.5474099), 90071992.5474099);
});

test('withOrderDecimals normalizes amount and price by the action and keeps every other field', () => {
    const conf = {
        keypair: { address: 'ltc1qexample', pubkey: '02ab' },
        action: 'SELL',
        type: 'SPOT',
        isLimitOrder: true,
        marketName: '1-2',
        props: { id_desired: 1, id_for_sale: 2, amount: 0.123456789, price: 0.1 + 0.2 },
    };
    const out = withOrderDecimals(conf);
    assert.deepEqual(out.props, { id_desired: 1, id_for_sale: 2, amount: 0.12345678, price: 0.3 });
    assert.deepEqual(out.keypair, conf.keypair);
    assert.equal(out.marketName, '1-2');
    // The caller's object is not modified.
    assert.equal(conf.props.amount, 0.123456789);
});

test('withOrderDecimals throws before anything is returned, so a refused order is not sent', () => {
    const conf = { action: 'BUY', props: { amount: 1e-9, price: 0.5 } };
    assert.throws(() => withOrderDecimals(conf), /smaller than/);
});

test('REGRESSION: a maximum BUY (available / price) never costs more than the available balance', () => {
    // The wallet's max BUY is available / price, a double. Rounding that amount UP (the old toFixed)
    // costs one unit more than the balance: 2 / 0.3 = 6.666... rounds to 6.66666667, cost 2.00000001.
    const cases = [
        [200000000n, 0.3], // 2 LTC at 0.3
        [100000000n, 0.3], // 1 LTC at 0.3
        [100000000n, 0.7],
        [300000000n, 0.011],
        [123456789n, 0.000123],
        [1n, 0.3],
        [987654321n, 1.1],
    ];
    for (const [availableUnits, price] of cases) {
        const available = Number(availableUnits) / 1e8;
        const max = available / price;
        const amount = toOrderAmount(max);
        const sentPrice = toOrderPrice(price, 'BUY');
        // cost = amount * price <= available  <=>  a * p <= available_units * 1e8, in exact units
        const cost = unitsOf(amount) * unitsOf(sentPrice);
        assert.ok(cost <= availableUnits * 100000000n, `available ${availableUnits} price ${price}: cost ${cost}`);
    }
});

test('REGRESSION: a typed sell amount with extra places is never raised above what was typed', () => {
    // toFixed(8) rounded 1.000000009 up to 1.00000001: one unit more than typed.
    assert.ok(toOrderAmount(1.000000009) <= 1.000000009);
    assert.equal(toOrderAmount(1.000000009), 1);
});
