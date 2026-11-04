// Known-answer generator: runs FE-speed's own crypto.util sign functions (transpiled unchanged)
// on synthetic keys and writes the vectors the Rust signer must reproduce byte for byte.
const fs = require('fs');
// usage: node gen-kat.cjs <out.json> <harness dir with dist/utils and node_modules>
const H = require('path').resolve(process.argv[3] || '.');
const req = (m) => require(require.resolve(m, { paths: [H] }));
const c = require(H + '/dist/utils/crypto.util.js');
const { networks } = require(H + '/dist/utils/networks.js');
const { Transaction, payments, Psbt, script, crypto: bcrypto } = req('bitcoinjs-lib');
const log = console.log; console.log = () => {};          // FE-speed's debug logging is noisy
const M1 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const M2 = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const NETS = ['LTC', 'LTCTEST', 'BTC', 'BTCTEST'];
const PATHS = ["m/49/60/1/0/0", "m/49/60/2/0/3", "m/49/60/4/0/0", "m/44'/1'/0'/0/0"];
const out = { mnemonics: { m1: M1, m2: M2 }, derive: [], signTx: [], signPsbt: [] };

for (const net of NETS) for (const p of PATHS) {
  for (const [mn, m] of [['m1', M1], ['m2', M2]]) {
    out.derive.push({ network: net, mnemonic: mn, path: p, expect: c.getKeyPair(net, m, p) });
  }
}

const NET = 'LTCTEST', N = networks[NET];
const A = c.getKeyPair(NET, M1, 'm/49/60/1/0/0');
const B = c.getKeyPair(NET, M2, 'm/49/60/2/0/0');
const pub = (k) => Buffer.from(k.pubkey, 'hex');
const ms = (ka, kb) => payments.p2ms({ m: 2, pubkeys: [pub(ka), pub(kb)], network: N }).output;   // pubkeys in given order
const p2wpkh = (k) => payments.p2wpkh({ pubkey: pub(k), network: N });
const p2shw = (k) => payments.p2sh({ redeem: p2wpkh(k), network: N });
const wsA = ms(A, B), wsB = ms(B, A);
const p2wshOf = (ws) => payments.p2wsh({ redeem: { output: ws, network: N }, network: N });
const txid = (n) => n.toString(16).padStart(2, '0').repeat(32);
const rev = (h) => Buffer.from(h, 'hex').reverse();

function rawTx(ins, outs, { version = 2, locktime = 0, seq = 0xffffffff } = {}) {
  const tx = new Transaction(); tx.version = version; tx.locktime = locktime;
  ins.forEach((i) => tx.addInput(rev(i.txid), i.vout, seq));
  outs.forEach((o) => tx.addOutput(o.script, o.value));
  return tx.toHex();
}
const dest = p2wpkh(B).output, dest2 = p2wpkh(A).output;

// ---- sign-tx (signRawTransction, FE-speed semantics) ----
function addTx(name, wif, inputs, outs, extra = {}) {
  const rawtx = rawTx(inputs, outs, extra);
  const feInputs = inputs.map((i) => ({ txid: i.txid, vout: i.vout, amount: i.amount, scriptPubKey: i.scriptPubKey, redeemScript: i.redeemScript }));
  const res = c.signRawTransction({ rawtx, wif, network: NET, inputs: feInputs });
  out.signTx.push({ name, network: NET, rawtx, wif: wif === A.wif ? 'A' : wif === B.wif ? 'B' : wif, inputs: feInputs, expect: res });
}
const inA = (n, amt = 0.001) => ({ txid: txid(n), vout: 0, amount: amt, scriptPubKey: p2shw(A).output.toString('hex') });
const inMs = (n, ws, amt = 0.002) => ({ txid: txid(n), vout: 1, amount: amt, scriptPubKey: payments.p2sh({ redeem: p2wshOf(ws), network: N }).output.toString('hex'), redeemScript: ws.toString('hex') });
addTx('single input', A.wif, [inA(0x11)], [{ script: dest, value: 90000 }]);
addTx('two inputs same key', A.wif, [inA(0x11), inA(0x12, 0.0025)], [{ script: dest, value: 200000 }, { script: dest2, value: 30000 }]);
addTx('multisig input, one signature', A.wif, [inMs(0x21, wsA)], [{ script: dest, value: 190000 }]);
addTx('multisig input, other key', B.wif, [inMs(0x21, wsA)], [{ script: dest, value: 190000 }]);
addTx('single plus multisig', A.wif, [inA(0x11), inMs(0x22, wsA)], [{ script: dest, value: 290000 }]);
addTx('key not in multisig', A.wif, [inMs(0x23, ms(B, B))], [{ script: dest, value: 190000 }]);
addTx('single plus multisig without the key', A.wif, [inA(0x13), inMs(0x24, ms(B, B))], [{ script: dest, value: 290000 }]);

// ---- sign-psbt (signPsbtRawtTx) ----
function mkPsbt(inputs, outs) {
  const psbt = new Psbt({ network: N });
  inputs.forEach((i) => psbt.addInput(i));
  outs.forEach((o) => psbt.addOutput(o));
  return psbt.toHex();
}
const names = new Map([[A.wif, 'A'], [B.wif, 'B']]);
function addPsbt(name, wif, psbtHex, network = NET) {
  const res = c.signPsbtRawtTx({ wif, network, psbtHex });
  out.signPsbt.push({ name, network, wif: names.get(wif), psbtHex, expect: res });
  return res;
}
const wu = (script, value) => ({ script, value });
const chan = (n, ws) => ({ hash: txid(n), index: 0, witnessUtxo: wu(p2wshOf(ws).output, 200000), witnessScript: ws });
const nat = (n, k) => ({ hash: txid(n), index: 1, witnessUtxo: wu(p2wpkh(k).output, 100000) });
const wrapped = (n, k) => ({ hash: txid(n), index: 2, witnessUtxo: wu(p2shw(k).output, 100000), redeemScript: p2wpkh(k).output });
const wrappedNoRedeem = (n, k) => ({ hash: txid(n), index: 2, witnessUtxo: wu(p2shw(k).output, 100000) });
const o = (s, v) => ({ script: s, value: v });
const p1 = mkPsbt([nat(0x31, A)], [o(dest, 90000)]);
addPsbt('native p2wpkh, key A', A.wif, p1);
addPsbt('native p2wpkh, wrong key', B.wif, p1);
const p2 = mkPsbt([chan(0x32, wsA)], [o(dest, 190000)]);
const r2 = addPsbt('channel input, first signer A', A.wif, p2);
addPsbt('channel input, second signer B', B.wif, r2.data.psbtHex);
addPsbt('channel input, first signer B', B.wif, p2);
addPsbt('channel input, A signs twice', A.wif, r2.data.psbtHex);
addPsbt('channel input, script order B,A', A.wif, mkPsbt([chan(0x33, wsB)], [o(dest, 190000)]));
const p3 = mkPsbt([wrapped(0x34, A)], [o(dest, 90000)]);
addPsbt('p2sh-p2wpkh with redeemScript', A.wif, p3);
addPsbt('p2sh-p2wpkh without redeemScript', A.wif, mkPsbt([wrappedNoRedeem(0x35, A)], [o(dest, 90000)]));
const p5 = mkPsbt([chan(0x36, wsA), nat(0x37, A)], [o(dest, 290000)]);
const r5 = addPsbt('trade psbt, A signs channel and commit', A.wif, p5);
addPsbt('trade psbt, B completes', B.wif, r5.data.psbtHex);
const p6 = mkPsbt([nat(0x38, A), nat(0x39, B)], [o(dest, 190000)]);
addPsbt('two native inputs of two keys, A', A.wif, p6);
addPsbt('wrong network id', A.wif, p1, 'BTC');
addPsbt('fee rate above 5000 sat/vB is not extracted', A.wif, mkPsbt([{ ...nat(0x3a, A), witnessUtxo: wu(p2wpkh(A).output, 5000000) }], [o(dest, 1000)]));
const r7 = addPsbt('channel input, script order B,A, first signer A', A.wif, mkPsbt([chan(0x3c, wsB)], [o(dest, 190000)]));
addPsbt('channel input, script order B,A, second signer B', B.wif, r7.data.psbtHex);
// a PSBT whose input already carries a non-ALL sighash type
{
  const psbt = new Psbt({ network: N }); psbt.addInput({ ...nat(0x3b, A), sighashType: 3 }); psbt.addOutput(o(dest, 90000));
  addPsbt('input sighash type SINGLE', A.wif, psbt.toHex());
}
out.keys = { A: { ...A, path: 'm/49/60/1/0/0', mnemonic: 'm1' }, B: { ...B, path: 'm/49/60/2/0/0', mnemonic: 'm2' } };
fs.writeFileSync(process.argv[2] || 'kat.json', JSON.stringify(out, null, 1));
log('derive', out.derive.length, 'signTx', out.signTx.length, 'signPsbt', out.signPsbt.length);
for (const t of out.signTx) log('TX  ', t.name, JSON.stringify(t.expect).slice(0, 110));
for (const t of out.signPsbt) log('PSBT', t.name, JSON.stringify(t.expect).replace(/"(psbtHex|finalHex)":"[0-9a-f]{20}[0-9a-f]*"/g, '"$1":"..."').slice(0, 150));
