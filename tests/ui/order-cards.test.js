'use strict';

// The spot and futures buy/sell cards send orders through the real order service, to a socket that
// records what the orderbook would receive. The orderbook accepts limit orders only (protocol parseNewOrder).

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadApp, APP, formGroup } = require('../support/fe-load');
const { loadTs } = require('../support/ts-loader');

const units = loadTs(path.join(APP, 'utils', 'units.ts')).exports;
const common = loadTs(path.join(APP, 'utils', 'common.util.ts')).exports;
const unitsStub = { 'src/app/utils/units': units };
const commonStub = { 'src/app/utils/common.util': common };
const rxjsStub = {
    'rxjs': { ReplaySubject: class { next() {} complete() {} } },
    'rxjs/operators': { takeUntil: () => (x) => x, first: () => (x) => x },
    '@angular/forms': { FormBuilder: class {}, FormGroup: class {}, Validators: { required: {}, min: () => ({}) } },
};
const cardStubs = { ...unitsStub, ...commonStub, ...rxjsStub };

const recordingSocket = () => {
    const emitted = [];
    return { emitted, socket: { emit: (event, payload) => emitted.push({ event, payload }) } };
};

const SPOT_MARKET = {
    pairString: 'TKN/LTC',
    first_token: { propertyId: 11, shortName: 'TKN', fullName: 'Token' },
    second_token: { propertyId: 0, shortName: 'LTC', fullName: 'Litecoin' },
};

const spotCard = (sock) => {
    const { SpotBuySellCardComponent } = loadApp('@pages/spot-page/spot-trading-grid/spot-buy-sell-card/spot-buy-sell-card.component.ts', cardStubs);
    const { SpotOrdersService } = loadApp('@core/services/spot-services/spot-orders.service.ts', {
        ...unitsStub, '../loading.service': { LoadingService: class {} }, '../socket.service': { SocketService: class {} },
    });
    const loading = { tradesLoading: false };
    const orders = new SpotOrdersService({ socket: sock.socket }, loading);
    const card = new SpotBuySellCardComponent(
        { selectedMarket: SPOT_MARKET }, { getCoinBalancesByAddress: () => ({ confirmedSats: 100000000, utxos: [] }) }, null,
        orders, { currentPrice: 0.5 }, { walletKeys: { spot: [{ address: 'SPOT', pubkey: 'PK' }] } },
        { error() {} }, { getAttByAddress: () => true }, loading, null, null, null,
    );
    card.buySellGroup = formGroup({ price: 0.5, amount: 2 });
    return card;
};

const FUTURES_MARKET = {
    pairString: 'FUT',
    contract_id: 0,
    collateral: { propertyId: 0 },
    first_token: { propertyId: 0, shortName: 'LTC', fullName: 'Litecoin' },
    second_token: { propertyId: 0, shortName: 'LTC', fullName: 'Litecoin' },
};

const futuresCard = (sock, market) => {
    const { FuturesBuySellCardComponent } = loadApp('@pages/futures-page/futures-trading-grid/futures-buy-sell-card/futures-buy-sell-card.component.ts', cardStubs);
    const { FuturesOrdersService } = loadApp('@core/services/futures-services/futures-orders.service.ts', {
        ...unitsStub, '../loading.service': { LoadingService: class {} }, '../socket.service': { SocketService: class {} },
    });
    const loading = { tradesLoading: false };
    const orders = new FuturesOrdersService({ socket: sock.socket }, loading);
    const card = new FuturesBuySellCardComponent(
        { selectedMarket: market }, { getCoinBalancesByAddress: () => ({ confirmedSats: 100000000, utxos: [] }) }, null,
        { walletKeys: { futures: [{ address: 'FUT', pubkey: 'PK' }] } }, { error() {} }, { getAttByAddress: () => true },
        loading, null, null, orders, { currentPrice: 0.5 }, null,
    );
    card.buySellGroup = formGroup({ price: 0.5, amount: 2 });
    return card;
};

test('a spot card order is a limit order even after the Market tab was selected: the orderbook refuses any other', () => {
    const sock = recordingSocket();
    const card = spotCard(sock);
    card.isLimitSelected = false;
    card.handleBuySell(true);
    assert.equal(sock.emitted.length, 1);
    assert.equal(sock.emitted[0].event, 'new-order');
    assert.equal(sock.emitted[0].payload.isLimitOrder, true);
    assert.equal(sock.emitted[0].payload.props.price, 50000000);
});

test('the spot and futures pages have no Market tab (the dead branch is deleted, not hidden)', () => {
    const root = path.join(APP, '@pages');
    for (const rel of ['spot-page/spot-trading-grid/spot-buy-sell-card/spot-buy-sell-card.component.html',
        'futures-page/futures-trading-grid/futures-buy-sell-card/futures-buy-sell-card.component.html']) {
        const html = fs.readFileSync(path.join(root, rel), 'utf8');
        assert.doesNotMatch(html, />Market</, `${rel} still has a Market tab`);
        assert.doesNotMatch(html, /Limit<\/p>/, `${rel} still has the order-type switch`);
    }
});

test('a futures contract with id 0 is a real market: the card sends its order', () => {
    const sock = recordingSocket();
    const card = futuresCard(sock, FUTURES_MARKET);
    card.handleBuySell(true);
    assert.equal(sock.emitted.length, 1, 'contract_id 0 was dropped as "no market"');
    assert.equal(sock.emitted[0].payload.props.contract_id, 0);
    assert.equal(sock.emitted[0].payload.isLimitOrder, true);
});

test('a futures card without a contract id still sends nothing', () => {
    const sock = recordingSocket();
    const card = futuresCard(sock, { ...FUTURES_MARKET, contract_id: undefined });
    card.handleBuySell(true);
    assert.equal(sock.emitted.length, 0);
});
