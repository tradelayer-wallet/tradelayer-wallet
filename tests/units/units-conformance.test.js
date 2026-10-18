'use strict';

// The shared units rules (protocol-v2.md B.2) against the conformance vectors the orderbook server
// also runs. The file's SHA-256 is pinned here and in the server's test; an edit to one copy fails
// that repo's test until the other copy is changed too.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadTs, REPO } = require('../support/ts-loader');

const VECTORS = path.join(REPO, 'tests', 'conformance', 'units-conformance.json');
const EXPECTED_SHA256 = 'c68d619fd9a05e837a77092cdd808eb3ed1ea52e26b71449a6043f22ab71393c';
const units = loadTs(path.join(REPO, 'packages', 'wallet-fe', 'src', 'app', 'utils', 'units.ts')).exports;

test('the vendored conformance file is the pinned copy', () => {
    const raw = fs.readFileSync(VECTORS);
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), EXPECTED_SHA256,
        'units-conformance.json differs from the copy pinned for this round: update both repos together');
});

test('every isWireUnits vector holds', () => {
    const vectors = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
    for (const v of vectors.isWireUnits) {
        assert.equal(units.isWireUnits(v.input), v.expect, `isWireUnits(${JSON.stringify(v.input)})`);
    }
});

test('every valueSats vector holds', () => {
    const vectors = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
    for (const v of vectors.valueSats) {
        assert.equal(units.valueSats(v.amountUnits, v.priceSats), v.expect, `valueSats(${v.amountUnits}, ${v.priceSats})`);
    }
});

test('every typedInput vector holds: typed text is read as typed, and a refused spelling throws', () => {
    const vectors = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
    for (const v of vectors.typedInput) {
        const call = () => (v.fn === 'toWirePrice' ? units.toWirePrice(v.input, v.action) : units.toWireAmount(v.input));
        const label = `${v.fn}(${JSON.stringify(v.input)}${v.action ? `, ${v.action}` : ''})`;
        if (v.expect === null) assert.throws(call, undefined, `${label} must be refused`);
        else assert.equal(call(), v.expect, label);
    }
});
