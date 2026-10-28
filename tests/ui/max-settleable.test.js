'use strict';

// The spot card's Max and typed orders, through the real card and order service, checked against the
// orderbook's settlement rule (copied from tl-orderbook-server src/utils/pure/units.ts:9-35, see
// tests/units/settleable.test.js). A Max that the orderbook would refuse is never sent.

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadApp, APP, formGroup } = require('../support/fe-load');
const { loadTs } = require('../support/ts-loader');

const units = loadTs(path.join(APP, 'utils', 'units.ts')).exports;
const common = loadTs(path.join(APP, 'utils', 'common.util.ts')).exports;
const rxjsStub = {
    'rxjs': { ReplaySubject: class { next() {} complete() {} } },
    'rxjs/operators': { takeUntil: () => (x) => x, first: () => (x) => x },
    '@angular/forms': { FormBuilder: class {}, FormGroup: class {}, Validators: { required: {}, min: () => ({}) } },
};
const cardStubs = { 'src/app/utils/units': units, 'src/app/utils/common.util': common, ...rxjsStub };

// tl-orderbook-server src/utils/pure/units.ts:9-35, copied (the sibling repo is not loaded by this one)
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
const orderbookValueSats = (amountUnits, priceSats) => {
    const product = mulDigitStrings(String(amountUnits), String(priceSats));
    if (product === '0') return 0;
    if (product.length <= 8 || !/^0{8}$/.test(product.slice(-8))) return null;
    const quotient = Number(product.slice(0, -8));
    return Number.isSafeInteger(quotient) ? quotient : null;
};

const MARKET = {
    pairString: 'TKN/LTC',
    first_token: { propertyId: 11, shortName: 'TKN', fullName: 'Token' },
    second_token: { propertyId: 0, shortName: 'LTC', fullName: 'Litecoin' },
};

// A spot card for MARKET with the given LTC balance (in sats) and token balance, price and amount.
const cardWith = ({ ltcSats = 1000000000, tokens = 0, price, amount = null }) => {
    const { SpotBuySellCardComponent } = loadApp('@pages/spot-page/spot-trading-grid/spot-buy-sell-card/spot-buy-sell-card.component.ts', cardStubs);
    const { SpotOrdersService } = loadApp('@core/services/spot-services/spot-orders.service.ts', {
        ...cardStubs, '../loading.service': { LoadingService: class {} }, '../socket.service': { SocketService: class {} },
        '../order-ledger.service': { OrderLedgerService: class {} },
    });
    const emitted = [];
    const toasts = [];
    const loading = { tradesLoading: false };
    const ledger = { record() {}, forget() {}, clear() {} };
    const orders = new SpotOrdersService({ socket: { emit: (event, payload) => emitted.push({ event, payload }) } }, loading, ledger);
    const balance = {
        getCoinBalancesByAddress: () => ({ confirmedSats: ltcSats, utxos: [] }),
        getTokensBalancesByAddress: () => [{ propertyid: 11, balance: tokens }],
    };
    const card = new SpotBuySellCardComponent(
        { selectedMarket: MARKET }, balance, null, orders, { currentPrice: price },
        { walletKeys: { spot: [{ address: 'SPOT', pubkey: 'PK' }] } },
        { error: (message) => toasts.push(message) }, { getAttByAddress: () => true }, loading, null, null, null,
    );
    card.buySellGroup = formGroup({ price, amount });
    return { card, emitted, toasts };
};

// Seeded values, so every run checks the same balances.
const seeded = (seed) => {
    let state = seed;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
};

test('Max buy: every order the spot card sends for a Max amount settles on the orderbook', () => {
    const next = seeded(0x51ed270b);
    const prices = [0.3, 0.7, 0.1234, 1.5, 0.5, 0.25, 0.00001234, 2, 0.12345678];
    for (const price of prices) {
        for (let i = 0; i < 25; i++) {
            const ltcSats = 100000000 + ((next() * 65536 + (next() & 0xffff)) % 2000000000);
            const { card, emitted } = cardWith({ ltcSats, price });
            card.fillMax(true);
            card.handleBuySell(true);
            assert.equal(emitted.length, 1, `Max buy at ${price} with ${ltcSats} sats was not sent`);
            const { amount, price: priceUnits } = emitted[0].payload.props;
            assert.notEqual(orderbookValueSats(amount, priceUnits), null,
                `Max buy at ${price} with ${ltcSats} sats sent ${amount} units at ${priceUnits}: the orderbook refuses it`);
        }
    }
});

test('Max sell: every order the spot card sends for a Max amount of the token settles on the orderbook', () => {
    const next = seeded(0x2f6e2b1);
    for (const price of [0.3, 0.7, 0.5, 1.5, 0.1234, 0.25, 2]) {
        for (let i = 0; i < 25; i++) {
            const tokens = units.unitsToNumber(1 + (next() * 65536 + (next() & 0xffff)) % 900000000000000);
            const { card, emitted } = cardWith({ tokens, price });
            card.fillMax(false);
            card.handleBuySell(false);
            assert.equal(emitted.length, 1, `Max sell at ${price} of ${tokens} tokens was not sent`);
            const { amount, price: priceUnits } = emitted[0].payload.props;
            assert.notEqual(orderbookValueSats(amount, priceUnits), null,
                `Max sell at ${price} of ${tokens} tokens sent ${amount} units at ${priceUnits}: the orderbook refuses it`);
        }
    }
});

test('the Max shown and filled in is the settleable amount, never above the raw Max', () => {
    // 10 LTC at 0.7: the raw Max is 1428571428.57 units, and only multiples of 10 units settle at 0.7.
    const { card } = cardWith({ ltcSats: 1000000000, price: 0.7 });
    const shown = card.getMaxAmount(true);
    assert.equal(units.toWireAmount(shown), 1428571420);
    assert.ok(shown <= 10 / 0.7, `Max ${shown} is above the balance`);
});

test('a typed order whose value is not whole satoshis is refused locally, with a message, and nothing is sent', () => {
    const { card, emitted, toasts } = cardWith({ price: 0.12345678, amount: 1.23456789 });
    card.handleBuySell(true);
    assert.equal(emitted.length, 0, 'the orderbook would refuse this order');
    assert.equal(toasts.length, 1);
    assert.match(toasts[0], /whole number of satoshis/);
});

test('a typed order that settles is sent as typed', () => {
    const { card, emitted, toasts } = cardWith({ price: 0.5, amount: 2 });
    card.handleBuySell(true);
    assert.equal(emitted.length, 1);
    assert.equal(toasts.length, 0);
});
