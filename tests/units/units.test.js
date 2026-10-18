'use strict';

// The wallet's units module (protocol-v2.md B.1, B.2): the one place a typed number becomes integer
// units, and units become an RPC string or a display number. Each rule has its own case.

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadTs, REPO } = require('../support/ts-loader');

const APP = path.join(REPO, 'packages', 'wallet-fe', 'src', 'app', 'utils');
const units = loadTs(path.join(APP, 'units.ts')).exports;

test('typed amounts round down to whole units, and 0.1 + 0.2 is exactly 0.3', () => {
    assert.equal(units.toWireAmount(0.1 + 0.2), 30000000);
    assert.throws(() => units.toWireAmount('1e-8'), /written in plain decimal/, 'exponent text is refused, not read');
    assert.equal(units.toWireAmount(0.123456789), 12345678, 'the ninth decimal is dropped, never rounded up');
    assert.equal(units.toWireAmount(1.9e-8), 1);
});

test('amounts that cannot be sent exactly throw: zero, negative, not finite, out of the safe range', () => {
    assert.throws(() => units.toWireAmount(0), /amount must be a positive number/);
    assert.throws(() => units.toWireAmount(-1), /amount must be a positive number/);
    assert.throws(() => units.toWireAmount(NaN), /amount must be a positive number/);
    assert.throws(() => units.toWireAmount(1e-9), /smaller than 0.00000001 after rounding/);
    assert.throws(() => units.toWireAmount(1.2e8), /too large to send exactly/);
});

test('price: a BUY rounds down, a SELL rounds up, in sats per whole token', () => {
    assert.equal(units.toWirePrice(0.123456789, 'BUY'), 12345678);
    assert.equal(units.toWirePrice(0.123456789, 'SELL'), 12345679);
    assert.equal(units.toWirePrice(0.3, 'BUY'), 30000000);
    assert.equal(units.toWirePrice(0.3, 'SELL'), 30000000);
});

test('leverage is a whole number of at least 1', () => {
    assert.equal(units.toWireLeverage(1), 1);
    assert.equal(units.toWireLeverage('3'), 3);
    assert.throws(() => units.toWireLeverage(0), /whole number of at least 1/);
    assert.throws(() => units.toWireLeverage(1.5), /whole number of at least 1/);
});

test('leverage text is read as typed: radix, exponent and sign spellings are refused, not converted', () => {
    assert.throws(() => units.toWireLeverage('0x3'), /whole number of at least 1/);
    assert.throws(() => units.toWireLeverage('3e0'), /whole number of at least 1/);
    assert.throws(() => units.toWireLeverage('+3'), /whole number of at least 1/);
    assert.throws(() => units.toWireLeverage(' 3 4 '), /whole number of at least 1/);
    assert.equal(units.toWireLeverage(' 3 '), 3);
});

test('toWireOrder converts amount and price, keeps the collateral id, and does not mutate its input', () => {
    const conf = {
        action: 'SELL',
        props: { contract_id: 4, amount: 0.5, price: 0.3, levarage: 1, collateral: 0 },
    };
    const out = units.toWireOrder(conf);
    assert.deepEqual(out.props, { contract_id: 4, amount: 50000000, price: 30000000, levarage: 1, collateral: 0 });
    assert.equal(conf.props.amount, 0.5, 'the caller object was changed');
});

test('toWireOrder throws before anything is emitted when a value cannot be sent exactly', () => {
    assert.throws(() => units.toWireOrder({ action: 'BUY', props: { amount: 1e-9, price: 1 } }), /smaller than/);
    assert.throws(() => units.toWireOrder({ action: 'BUY', props: { amount: 1, price: 1, levarage: 2.5 } }), /whole number/);
});

test('unitsToDecimal writes exact decimals, never exponent form, trailing zeros dropped', () => {
    assert.equal(units.unitsToDecimal(5), '0.00000005');
    assert.equal(units.unitsToDecimal(1), '0.00000001');
    assert.equal(units.unitsToDecimal(100), '0.000001');
    assert.equal(units.unitsToDecimal(150000000), '1.5');
    assert.equal(units.unitsToDecimal(100000000), '1');
    assert.equal(units.unitsToDecimal(0), '0');
    assert.equal(units.unitsToDecimal(9007199254740991), '90071992.54740991');
    assert.throws(() => units.unitsToDecimal(0.5), /not a quantity in units/);
    assert.throws(() => units.unitsToDecimal(-1), /not a quantity in units/);
});

test('ltcToSats takes whole satoshis from a node float and refuses anything else', () => {
    assert.equal(units.ltcToSats(0.00006), 6000);
    assert.equal(units.ltcToSats(0.1 + 0.2), 30000000, 'float noise below 1e-6 satoshi is not a fraction');
    assert.throws(() => units.ltcToSats(0.000000015), /not a whole number of satoshis/);
    assert.throws(() => units.ltcToSats(-1), /not a non-negative number/);
    assert.throws(() => units.ltcToSats('1'), /not a non-negative number/);
});

test('satsToLtc and unitsToNumber are the one display and node-float conversion', () => {
    assert.equal(units.satsToLtc(6000), 0.00006);
    assert.equal(units.unitsToNumber(150000000), 1.5);
});

test('valueSats is exact, or null when the value is not a whole number of satoshis', () => {
    assert.equal(units.valueSats(50000000, 30000000), 15000000);
    assert.equal(units.valueSats(13779, 150000000), null);
    assert.equal(units.valueSats(1, 1), null);
});

test('no swap amount is sent through toString() or a float RPC string', () => {
    const dir = path.join(APP, 'swapper');
    for (const file of ['buyer.ts', 'seller.ts', 'swap.ts']) {
        const source = fs.readFileSync(path.join(dir, file), 'utf8');
        assert.doesNotMatch(source, /(amount\w*|price)\)?\.toString\(\)/, `${file} sends an amount with toString()`);
        assert.doesNotMatch(source, /rpcAmount/, `${file} still uses the removed rpcAmount`);
    }
});
