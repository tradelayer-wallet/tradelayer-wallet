#!/usr/bin/env node
// Legacy parity harness for the spot/futures buy-sell cards. Dependency-free: it slices the
// pinned component methods (getFees, getMaxAmount, getInOrderAmount, getTotal) out of the
// TypeScript source, strips the type annotations, binds them to a fake `this` and prints their
// results for fixed inputs. The Angular classes themselves cannot be loaded.
//
//   node scripts/compare-orderform.cjs            # print JSON
//   node scripts/compare-orderform.cjs --write    # refresh scripts/legacy-orderform.json
//
// tests/orderform.rs reads scripts/legacy-orderform.json (inputs and legacy outputs together).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const APP = 'packages/wallet-fe/src/app';
const FILES = {
  spot: `${APP}/@pages/spot-page/spot-trading-grid/spot-buy-sell-card/spot-buy-sell-card.component.ts`,
  futures: `${APP}/@pages/futures-page/futures-trading-grid/futures-buy-sell-card/futures-buy-sell-card.component.ts`,
  common: `${APP}/utils/common.util.ts`,
};
const PINNED = {
  spot: '8084a278e0e587d51cae99f5effbde043db6b1c4',
  futures: 'ad90f24e31051e353c79a2799a0a266e50de2bdc',
  common: '5581baadb1febe58125636eec9a7f5d578773e77',
};

function read(rel) {
  const buf = fs.readFileSync(path.join(repoRoot, rel));
  const text = buf.toString('utf8').replace(/\r\n/g, '\n'); // git stores LF
  const lf = Buffer.from(text, 'utf8');
  const sha = crypto.createHash('sha1').update(`blob ${lf.length}\0`).update(lf).digest('hex');
  return { text, sha };
}

const src = {};
for (const k of Object.keys(FILES)) {
  src[k] = read(FILES[k]);
  if (src[k].sha !== PINNED[k]) {
    console.error(`${FILES[k]} blob ${src[k].sha} differs from the pinned oracle ${PINNED[k]}`);
    process.exit(2);
  }
}

// Slice `    name(...) {` ... `\n    }\n` (4-space class members) and strip TS annotations.
function method(text, name) {
  const re = new RegExp(`\\n    (?:private )?${name}\\(`);
  const m = re.exec(text);
  if (!m) throw new Error(`${name} not found`);
  const start = m.index + 1;
  const end = text.indexOf('\n    }\n', start);
  const body = text.slice(start, end + 6);
  return body
    .replace(/^\s*(?:private )?/, 'function ')
    .replace(/:\s*(?:boolean|number\[\]|number|any|string)(?=\s*[,)=;{])/g, '')
    .replace(/:\s*(?:boolean|number|string)\s*(?=\{)/g, '');
}

const NAMES = ['getFees', 'getMaxAmount', 'getInOrderAmount', 'getTotal'];
function load(kind) {
  const code = [
    src.common.text.replace('export ', '').replace(/:\s*number/g, ''),
    'const minFeeLtcPerKb = 0.002;',
    'const minVOutAmount = 0.000036;',
    ...NAMES.filter((n) => kind === 'spot' || n !== 'getTotal').map((n) => method(src[kind].text, n)),
    `return { ${NAMES.filter((n) => kind === 'spot' || n !== 'getTotal').join(', ')} };`,
  ].join('\n');
  return new Function(code)();
}
const legacy = { spot: load('spot'), futures: load('futures') };

const toSat = (c) => (Number.isFinite(c) ? Math.round(c * 1e8) : null);

function fakeThis(kind, c) {
  const form = { price: c.price ?? null, amount: c.amount ?? null };
  const t = {
    buySellGroup: { value: form, controls: { price: { value: form.price }, amount: { value: form.amount } } },
    isLimitSelected: c.isLimit,
    currentPrice: c.currentPrice,
    balanceService: {
      getCoinBalancesByAddress: () => ({ confirmed: c.confirmed, utxos: c.utxos.map((amount) => ({ amount })) }),
      getTokensBalancesByAddress: () => c.tokens.map(([propertyid, balance]) => ({ propertyid, balance })),
    },
  };
  if (kind === 'spot') {
    t.spotAddress = 'addr';
    t.selectedMarket = {
      first_token: { propertyId: c.first, shortName: 'FIRST' },
      second_token: { propertyId: c.second, shortName: 'SECOND' },
    };
    t.spotOrdersService = {
      openedOrders: c.orders.map((o) => ({ props: { amount: o.amount, price: o.price, id_for_sale: o.asset } })),
    };
  } else {
    t.futureAddress = 'addr';
    t.selectedMarket = { collateral: { propertyId: c.collateral } };
    t.futuresOrdersService = {
      openedOrders: c.orders.map((o) => ({ props: { amount: o.amount, price: o.price, collateral: o.asset } })),
    };
  }
  for (const n of NAMES) if (legacy[kind][n]) t[n] = legacy[kind][n].bind(t);
  return t;
}

const base = { utxos: [], confirmed: 0, tokens: [], orders: [], isLimit: true, currentPrice: 0, price: null, amount: null };
const cases = [
  // spot, LTC quote: BUY pays LTC
  { id: 'spot_ltc_quote_buy_fee_and_max', kind: 'spot', first: 3, second: -1, utxos: [0.5, 0.2, 0.05], confirmed: 0.75, tokens: [[3, 10]], price: 0.5, amount: 0.2 },
  { id: 'spot_ltc_quote_one_big_utxo', kind: 'spot', first: 3, second: -1, utxos: [2], confirmed: 2, tokens: [[3, 10]], price: 0.25, amount: 1 },
  { id: 'spot_ltc_quote_many_small_utxos', kind: 'spot', first: 3, second: -1, utxos: [0.01, 0.01, 0.01, 0.01, 0.01, 0.01], confirmed: 0.06, tokens: [], price: 0.05, amount: 0.5 },
  // spot, token/token: fee path uses 2 * min output
  { id: 'spot_token_token', kind: 'spot', first: 3, second: 5, utxos: [0.01, 0.002], confirmed: 0.012, tokens: [[3, 10], [5, 20]], price: 2, amount: 3 },
  { id: 'spot_token_token_open_buy_order', kind: 'spot', first: 3, second: 5, utxos: [0.01], confirmed: 0.01, tokens: [[3, 10], [5, 20]], orders: [{ asset: 5, amount: 1, price: 2 }], price: 2, amount: 3 },
  // legacy rounds available/price to the nearest 6 decimals: 0.2/0.3 -> 0.666667, cost 0.2000001
  { id: 'spot_max_rounds_up_over_balance', kind: 'spot', first: 3, second: 5, utxos: [0.01], confirmed: 0.01, tokens: [[3, 10], [5, 0.2]], price: 0.3, amount: 0.1 },
  { id: 'spot_max_exact_division', kind: 'spot', first: 3, second: 5, utxos: [0.01], confirmed: 0.01, tokens: [[3, 10], [5, 0.9]], price: 0.3, amount: 0.1 },
  // SELL reservation: legacy reserved amount*price of the *base* asset
  { id: 'spot_open_sell_order_reservation', kind: 'spot', first: 3, second: 5, utxos: [0.01], confirmed: 0.01, tokens: [[3, 10], [5, 20]], orders: [{ asset: 3, amount: 4, price: 3, side: 'SELL' }], price: 2, amount: 1 },
  // SELL of LTC (base asset): legacy funded amount*price instead of amount
  { id: 'spot_ltc_base_sell', kind: 'spot', first: -1, second: 3, utxos: [1, 1, 1], confirmed: 3, tokens: [[3, 100]], price: 0.1, amount: 2 },
  // LTC reserved 0.001 per open non-LTC order
  { id: 'spot_ltc_fee_reserve_per_open_order', kind: 'spot', first: 3, second: -1, utxos: [1], confirmed: 1, tokens: [[3, 10]], orders: [{ asset: 3, amount: 1, price: 1 }, { asset: 3, amount: 1, price: 1 }], price: 0.5, amount: 1 },
  // market order with an empty book: legacy max = Infinity
  { id: 'spot_market_order_no_price', kind: 'spot', first: 3, second: 5, utxos: [0.01], confirmed: 0.01, tokens: [[3, 10], [5, 20]], isLimit: false, currentPrice: 0, price: 2, amount: 3 },
  { id: 'spot_market_order_with_price', kind: 'spot', first: 3, second: 5, utxos: [0.01], confirmed: 0.01, tokens: [[3, 10], [5, 20]], isLimit: false, currentPrice: 4, price: 2, amount: 3 },
  { id: 'spot_empty_form', kind: 'spot', first: 3, second: -1, utxos: [1], confirmed: 1, tokens: [[3, 10]] },
  // futures
  { id: 'futures_collateral_token', kind: 'futures', collateral: 5, utxos: [0.01, 0.002], confirmed: 0.012, tokens: [[5, 20]], price: 2, amount: 3 },
  { id: 'futures_sell_max_ignores_price', kind: 'futures', collateral: 5, utxos: [0.01], confirmed: 0.01, tokens: [[5, 20]], price: 4, amount: 1 },
  { id: 'futures_open_order_collateral', kind: 'futures', collateral: 5, utxos: [0.01], confirmed: 0.01, tokens: [[5, 20]], orders: [{ asset: 5, amount: 2, price: 3 }], price: 2, amount: 1 },
].map((c) => ({ ...base, ...c }));

const out = {
  oracle: {
    files: Object.fromEntries(Object.keys(FILES).map((k) => [FILES[k], src[k].sha])),
    baseline_commit: '7ddba36ca06538510e6460df0ddece8a71fcb547',
    generated_by: 'node scripts/compare-orderform.cjs --write',
  },
  cases: cases.map((c) => {
    const t = fakeThis(c.kind, c);
    const props = c.kind === 'spot' ? [c.first, c.second] : [c.collateral];
    const side = (isBuy) => {
      const r = { fee_sat: toSat(t.getFees(isBuy)), max_sat: toSat(t.getMaxAmount(isBuy)) };
      if (c.kind === 'spot') r.total = t.getTotal(isBuy);
      return r;
    };
    return {
      ...c,
      price_sat: c.price === null ? null : toSat(c.price),
      legacy: {
        buy: side(true),
        sell: side(false),
        in_order_sat: Object.fromEntries(props.map((p) => [String(p), toSat(t.getInOrderAmount(p))])),
      },
    };
  }),
};

const json = JSON.stringify(out, null, 2) + '\n';
if (process.argv.includes('--write')) {
  fs.writeFileSync(path.join(__dirname, 'legacy-orderform.json'), json);
  console.error('wrote scripts/legacy-orderform.json');
} else {
  process.stdout.write(json);
}
