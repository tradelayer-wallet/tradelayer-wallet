'use strict';

// The confirmed LTC balance is kept in whole satoshis from the node's UTXOs, and a Max value is never
// above it (fuzz r14 F3: a 6-place rounding of the balance let Max ask for more LTC than the UTXOs hold).

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadApp, APP, formGroup } = require('../support/fe-load');
const { loadTs } = require('../support/ts-loader');

const units = loadTs(path.join(APP, 'utils', 'units.ts')).exports;
const common = loadTs(path.join(APP, 'utils', 'common.util.ts')).exports;
const unitsStub = { 'src/app/utils/units': units };
const rxjsStub = {
    'rxjs': { ReplaySubject: class { next() {} complete() {} } },
    'rxjs/operators': { takeUntil: () => (x) => x, first: () => (x) => x },
    '@angular/forms': { FormBuilder: class {}, FormGroup: class {}, Validators: { required: {}, min: () => ({}) } },
};

// One confirmed UTXO of 1.0000006 LTC: 100000060 satoshis, which 6-place rounding would show as 1.000001.
const UTXOS = [{ txid: 'ab', vout: 0, amount: 1.0000006, confirmations: 3, scriptPubKey: '' }];

const loadedBalance = async (utxos = UTXOS) => {
    const { BalanceService } = loadApp('@core/services/balance.service.ts', {
        ...unitsStub, './rpc.service': { RpcService: class {} }, './auth.service': { AuthService: class {} },
        './api.service': { ApiService: class {} }, 'ngx-toastr': {},
    });
    const rpc = { rpc: async (method) => ({ data: method === 'listunspent' ? utxos : [] }) };
    const api = { newTlApi: { rpc: () => ({ toPromise: async () => ({ data: [] }) }) } };
    const balance = new BalanceService(rpc, { walletAddresses: ['SPOT'] }, { warning() {} }, api);
    await balance.updateBalances();
    return balance;
};

const spotCard = (balance, market) => {
    const { SpotBuySellCardComponent } = loadApp('@pages/spot-page/spot-trading-grid/spot-buy-sell-card/spot-buy-sell-card.component.ts', {
        ...unitsStub, 'src/app/utils/common.util': common, ...rxjsStub,
    });
    const card = new SpotBuySellCardComponent(
        { selectedMarket: market }, balance, null, { openedOrders: [] }, { currentPrice: 0.5 },
        { walletKeys: { spot: [{ address: 'SPOT', pubkey: 'PK' }] } }, { error() {} }, { getAttByAddress: () => true },
        { tradesLoading: false }, null, null, null,
    );
    card.buySellGroup = formGroup({ price: 0.5, amount: null });
    return card;
};

const LTC_FIRST = {
    pairString: 'LTC/TKN',
    first_token: { propertyId: 0, shortName: 'LTC', fullName: 'Litecoin' },
    second_token: { propertyId: 11, shortName: 'TKN', fullName: 'Token' },
};
const LTC_SECOND = {
    pairString: 'TKN/LTC',
    first_token: { propertyId: 11, shortName: 'TKN', fullName: 'Token' },
    second_token: { propertyId: 0, shortName: 'LTC', fullName: 'Litecoin' },
};

test('the confirmed balance is the sum of the UTXOs in whole satoshis, not a 6-place rounding of it', async () => {
    const balance = await loadedBalance();
    assert.equal(balance.getCoinBalancesByAddress('SPOT').confirmedSats, 100000060);
    assert.equal(balance.sumAvailableCoins, 1.0000006);
});

test('a UTXO that is not a whole number of satoshis is refused, not summed', async () => {
    const balance = await loadedBalance([{ ...UTXOS[0], amount: 1.000000015 }]);
    assert.deepEqual(balance.getCoinBalancesByAddress('SPOT').utxos, [], 'the balance was replaced with a rounded one');
    assert.equal(balance.getCoinBalancesByAddress('SPOT').confirmedSats, 0);
});

test('Max for an LTC sale is exactly the confirmed LTC balance, never above it', async () => {
    const balance = await loadedBalance();
    const card = spotCard(balance, LTC_FIRST);
    assert.equal(card.getMaxAmount(false), 1.0000006);
});

test('Max for an LTC buy, in tokens, never asks for more LTC than the balance holds', async () => {
    const balance = await loadedBalance();
    const card = spotCard(balance, LTC_SECOND);
    const max = card.getMaxAmount(true);
    assert.ok(max <= 1.0000006 / 0.5, `max ${max} asks for more LTC than the balance`);
});

test('the amount Max fills in is never more than the UTXOs hold once it is sent', async () => {
    const balance = await loadedBalance();
    const card = spotCard(balance, LTC_FIRST);
    card.fillMax(false);
    assert.ok(units.toWireAmount(card.buySellGroup.value.amount) <= 100000060,
        `Max sends ${units.toWireAmount(card.buySellGroup.value.amount)} units of LTC`);
});
