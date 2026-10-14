'use strict';

// The orderbook server refuses an amount or price that is not a whole number of 1e-8 units
// (tl-orderbook-server src/utils/pure/mix.pure.ts toUnits). Every outbound order must pass that
// check, so these tests use the same rule. Runs against the real order-decimals.ts.

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadTs, REPO } = require('../support/ts-loader');

const { toOrderDecimal, withOrderDecimals } = loadTs(
    path.join(REPO, 'packages', 'wallet-fe', 'src', 'app', 'utils', 'order-decimals.ts'),
).exports;

// The server's rule, copied from toUnits: the value must equal its own 1e-8 grid point.
const serverAccepts = (value) => {
    const units = Math.round(value * 1e8);
    return Number.isSafeInteger(units) && units / 1e8 === value;
};

test('float sums are rounded to the 1e-8 grid the server accepts', () => {
    const raw = 0.1 + 0.2; // 0.30000000000000004: refused by the server as sent
    assert.equal(serverAccepts(raw), false);
    assert.equal(toOrderDecimal(raw), 0.3);
    assert.equal(serverAccepts(toOrderDecimal(raw)), true);
});

test('user input with more than 8 decimal places is rounded, not sent as typed', () => {
    assert.equal(toOrderDecimal(0.123456789), 0.12345679);
    assert.equal(toOrderDecimal('0.123456789'), 0.12345679);
});

test('values already on the grid are unchanged', () => {
    for (const v of [0.1, 1.1, 0.00000001, 123.45678901, 2100000]) {
        assert.equal(toOrderDecimal(v), v);
        assert.equal(serverAccepts(toOrderDecimal(v)), true);
    }
});

test('withOrderDecimals normalizes amount and price and keeps every other field', () => {
    const conf = {
        keypair: { address: 'ltc1qexample', pubkey: '02ab' },
        action: 'BUY',
        type: 'SPOT',
        isLimitOrder: true,
        marketName: '1-2',
        props: { id_desired: 1, id_for_sale: 2, amount: 0.123456789, price: 0.1 + 0.2 },
    };
    const out = withOrderDecimals(conf);
    assert.deepEqual(out.props, { id_desired: 1, id_for_sale: 2, amount: 0.12345679, price: 0.3 });
    assert.deepEqual(out.keypair, conf.keypair);
    assert.equal(out.marketName, '1-2');
    // The caller's object is not modified.
    assert.equal(conf.props.amount, 0.123456789);
});
