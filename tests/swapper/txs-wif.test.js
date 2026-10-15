'use strict';

// The swap steps sign with the WIF of the address they trade from. TxsService.getWifByAddress
// must return the key AuthService holds for that address, or every swap step fails with
// "WIF not found". Runs against the real txs.service.ts; Angular and the other services are stubs.

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadTs, REPO } = require('../support/ts-loader');

class Stub {}
const stubs = {
    '@angular/core': { Injectable: () => () => {} },
    'ngx-toastr': { ToastrService: Stub },
    './api.service': { ApiService: Stub },
    './auth.service': { AuthService: Stub },
    './balance.service': { BalanceService: Stub },
    './loading.service': { LoadingService: Stub },
    './rpc.service': { RpcService: Stub },
};

const { TxsService } = loadTs(
    path.join(REPO, 'packages', 'wallet-fe', 'src', 'app', '@core', 'services', 'txs.service.ts'),
    stubs,
).exports;

const authWith = (keys) => ({
    getWifByAddress: (address) => keys[address]?.wif || null,
});

test('getWifByAddress returns the WIF AuthService holds for the address', () => {
    const txs = new TxsService(null, null, authWith({ LTC1: { wif: 'WIF-1' } }), null, null, null);
    assert.equal(txs.getWifByAddress('LTC1'), 'WIF-1');
});

test('getWifByAddress is empty for an address the wallet holds no key for', () => {
    const txs = new TxsService(null, null, authWith({ LTC1: { wif: 'WIF-1' } }), null, null, null);
    assert.ok(!txs.getWifByAddress('LTC2'), 'a key was returned for an unknown address');
});
