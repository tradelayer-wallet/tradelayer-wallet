#!/usr/bin/env node
// Legacy parity harness for the UTXO selection / fee arithmetic of tx-builder.service.ts.
// Dependency-free: it slices the pinned legacy functions out of the TypeScript source, strips the
// type annotations, evaluates them, and prints (or writes) their results for fixed inputs.
//
//   node scripts/compare-legacy.cjs            # print JSON
//   node scripts/compare-legacy.cjs --write    # refresh scripts/legacy-vectors.json
//
// The Rust test `tests/legacy_parity.rs` reads scripts/legacy-vectors.json.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const PINNED = {
  'packages/wallet-server/src/services/tx-builder.service.ts': '2b11ba8ed36dce681cc11b5777fc2041efb62f21',
  'packages/wallet-server/src/utils/common.util.ts': null, // recorded below, informational
};

function blobSha(buf) {
  const lf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'); // git stores LF
  return crypto.createHash('sha1').update(`blob ${lf.length}\0`).update(lf).digest('hex');
}

function read(rel) {
  const buf = fs.readFileSync(path.join(repoRoot, rel));
  return { text: buf.toString('utf8').replace(/\r\n/g, '\n'), sha: blobSha(buf) };
}

const tx = read('packages/wallet-server/src/services/tx-builder.service.ts');
const cu = read('packages/wallet-server/src/utils/common.util.ts');
if (tx.sha !== PINNED['packages/wallet-server/src/services/tx-builder.service.ts']) {
  console.error(`tx-builder.service.ts blob ${tx.sha} differs from the pinned oracle`);
  process.exit(2);
}

function extract(src, name) {
  const start = src.indexOf(`const ${name} = (`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf('\n};', start);
  const body = src.slice(start, end + 3);
  return body.replace(/:\s*(?:IInput\[\]|number)(?![A-Za-z])/g, '');
}

const safeNumberSrc = cu.text.replace('export ', '').replace(/:\s*number/g, '');
const code = [
  safeNumberSrc,
  'const minFeeLtcPerKb = 0.002;',
  extract(tx.text, 'getEnoughInputs2'),
  extract(tx.text, 'getEnoughInputs'),
  'return { safeNumber, getEnoughInputs, getEnoughInputs2 };',
].join('\n');
const legacy = new Function(code)();

const toSat = (c) => Math.round(c * 1e8);

// [wallet utxo amounts in coin (already in candidate order), amount in coin]
const cases = [
  [[0.5, 0.2, 0.05], 0.1],
  [[0.3, 0.3, 0.3], 0.5],
  [[1], 0.9999],
  [[0.0006, 0.0006, 0.0006, 0.0006], 0.001],
  [[0.01, 0.01, 0.01, 0.01, 0.01], 0.03],
  [[0.00004, 0.00004, 0.5], 0.002],
  [[2, 1], 2.5],
  [[0.123456, 0.654321, 0.000001], 0.7],
];

const out = {
  oracle: {
    file: 'packages/wallet-server/src/services/tx-builder.service.ts',
    blob: tx.sha,
    common_util_blob: cu.sha,
    baseline_commit: '7ddba36ca06538510e6460df0ddece8a71fcb547',
    generated_by: 'node scripts/compare-legacy.cjs --write',
  },
  fee_per_input_sat: toSat(legacy.safeNumber(0.3 * 0.002 * 1)),
  cases: cases.map(([amounts, amount]) => {
    const utxos = amounts.map((a, i) => ({ amount: a, id: i }));
    const g1 = legacy.getEnoughInputs(utxos, amount);
    const g2 = legacy.getEnoughInputs2(utxos, amount);
    return {
      utxos_sat: amounts.map(toSat),
      amount_sat: toSat(amount),
      legacy_get_enough_inputs: { count: g1.finalInputs.length, fee_sat: toSat(g1.fee) },
      legacy_get_enough_inputs2: { count: g2.finalInputs.length, fee_sat: toSat(g2.fee) },
    };
  }),
};

const json = JSON.stringify(out, null, 2) + '\n';
if (process.argv.includes('--write')) {
  fs.writeFileSync(path.join(__dirname, 'legacy-vectors.json'), json);
  console.error('wrote scripts/legacy-vectors.json');
} else {
  process.stdout.write(json);
}
