'use strict';

// Every amount that the wallet UI sends to an RPC goes through unitsToDecimal (fuzz and r14 F2): a
// Number.toString() of a float writes exponent form below 1e-6 and float noise above 8 places.

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadApp, APP } = require('../support/fe-load');
const { loadTs } = require('../support/ts-loader');

const units = loadTs(path.join(APP, 'utils', 'units.ts')).exports;
const unitsStub = { 'src/app/utils/units': units };

const recordingRpc = (reply) => {
    const calls = [];
    return { calls, rpc: async (method, params) => { calls.push({ method, params }); return reply(method); } };
};

test('a token withdrawal sends its amount as a plain decimal with at most 8 places', async () => {
    const { WithdrawDialog } = loadApp('@shared/dialogs/withdraw/withdraw.component.ts', unitsStub);
    for (const [typed, sent] of [[1e-7, '0.0000001'], [0.1 + 0.2, '0.3'], [1.23456789, '1.23456789']]) {
        const rec = recordingRpc(() => ({ data: 'PAYLOAD' }));
        const dialog = new WithdrawDialog({ propId: 5, address: 'FROM' }, null, null, null, null, null, null, null, { rpc: rec.rpc });
        const res = await dialog.getTxOptions('FROM', 'TO', typed, 5);
        assert.equal(res.error, undefined);
        assert.equal(rec.calls[0].method, 'tl_createpayload_simplesend');
        assert.deepEqual(rec.calls[0].params, [5, sent], `typed ${typed}`);
    }
});

test('a channel commit close sends its amount as a plain decimal, from the commit list the service builds', async () => {
    const { SpotChannelsService } = loadApp('@core/services/spot-services/spot-channels.service.ts', {
        '@angular/core': { Injectable: () => () => {} },
        'ngx-toastr': {},
        '../auth.service': { AuthService: class {} },
        '../balance.service': { BalanceService: class {} },
        '../rpc.service': { RpcService: class {} },
    });
    const { SpotChannelsComponent } = loadApp('@pages/spot-page/spot-trading-grid/spot-bottom-card/spot-channels/spot-channels.component.ts', unitsStub);
    const rec = recordingRpc((method) => (method === 'tl_check_commits'
        ? { data: [{ amount: '0.0000001', propertyId: '5', block: 9, channel: 'CHAN', sender: 'SENDER' }] }
        : { data: 'PAYLOAD' }));
    const service = new SpotChannelsService({ rpc: rec.rpc }, { activeSpotKey: { address: 'SPOT' } }, { warning() {} },
        { getTokenNameById: async () => 'TKN' });
    await service.updateOpenChannels();
    const [commit] = service.channelsCommits;
    const component = new SpotChannelsComponent(service, { rpc: rec.rpc }, null, { buildSingSendTx: async () => ({ data: 'TXID' }) },
        { isLoading: false }, { success() {}, error() {} });
    await component.closeCommit(commit);
    assert.deepEqual(rec.calls[1], { method: 'tl_createpayload_withdrawal_fromchannel', params: [5, '0.0000001'] });
});

test('a futures commit close sends its amount as a plain decimal', async () => {
    const { FuturesChannelsComponent } = loadApp('@pages/futures-page/futures-trading-grid/futures-bottom-card/futures-commits/futures-commits.component.ts', unitsStub);
    const rec = recordingRpc(() => ({ data: 'PAYLOAD' }));
    const component = new FuturesChannelsComponent(null, { rpc: rec.rpc }, null, { buildSingSendTx: async () => ({ data: 'TXID' }) },
        { isLoading: false }, { success() {}, error() {} }, null);
    await component.closeCommit({ propertyId: 7, amount: 1e-7, sender: 'S', channel: 'C' });
    assert.deepEqual(rec.calls[0], { method: 'tl_createpayload_withdrawal_fromchannel', params: [7, '0.0000001'] });
});

test('the transaction builder sends a typed amount as a plain decimal, and a refused amount is reported, not thrown', async () => {
    const { BuildTxTabComponent } = loadApp('@pages/tx-builder-page/build-tab/build-tab.component.ts', unitsStub);
    const txType = (rpc) => new BuildTxTabComponent(null, null, null, null).transactionTypes.find(t => t.rpc === rpc);
    const form = (values) => ({ valid: true, get: (code) => ({ value: values[code] }) });
    const run = async (values, reply) => {
        const rec = recordingRpc(reply);
        const c = new BuildTxTabComponent({ info() {} }, null, { rpc: rec.rpc }, { buildTx: async () => ({ data: { rawtx: 'RAW' } }) });
        c.selectedTxType = txType('tl_createpayload_simplesend');
        c.txTypeForm = form(values);
        c.sendAddress = 'FROM';
        c.receiveAddress = 'TO';
        await c.build();
        return { rec, c };
    };
    const ok = await run({ prop_id: 5, amount: 1e-7 }, () => ({ data: 'PAYLOAD' }));
    assert.deepEqual(ok.rec.calls[0].params, [5, '0.0000001']);
    const refused = await run({ prop_id: 5, amount: 0 }, () => ({ data: 'PAYLOAD' }));
    assert.equal(refused.rec.calls.length, 0);
    assert.match(refused.c.output, /^Error: amount must be a positive number/);
});

test('no amount in wallet-fe is written as toString() or a template literal (the RPC gets unitsToDecimal only)', () => {
    const fs = require('fs');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
        ? walk(path.join(dir, e.name))
        : /\.(ts|html)$/.test(e.name) && !/\(old\)/.test(e.name) ? [path.join(dir, e.name)] : []));
    const offenders = [];
    for (const file of walk(APP)) {
        const source = fs.readFileSync(file, 'utf8');
        // A display label may name an amount; the RPC-bound ones are the ones passed to rpc() or buildTx().
        if (/amount[A-Za-z]*\)?\.toString\(\)|\$\{[^}]*amount[^}]*\}/.test(source)
            && !/getTotal\(/.test(source) && /rpc\(|client\(|buildTx|sendRpc/.test(source)) offenders.push(path.relative(APP, file));
    }
    assert.deepEqual(offenders, [], 'an RPC-bound file still writes an amount with toString() or a template literal');
});
