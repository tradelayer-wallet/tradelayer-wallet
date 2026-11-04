// node --test scripts/test-bitcorn-instrument.mjs  (Node >= 22.18 runs the .ts file directly)
import test from "node:test";
import assert from "node:assert/strict";
import { canon, planInstrument } from "../ui-overlay/fe-speed-skin/bitcorn-instrument.ts";

test("canon strips synth, testnet and oracle spellings", () => {
  assert.deepEqual(["TLTC", "sLTC", "sLTCt", "sBTC", "USDTt", "TLt", "XBT", "LTC", "TL"].map(canon),
    ["LTC", "LTC", "LTC", "BTC", "USDT", "TL", "BTC", "LTC", "TL"]);
});

const plan = (kind, base, quote) => planInstrument({ kind, base, quote });

test("futures: BTC and LTC against USDT map to perpetuals with a spot fallback", () => {
  const btc = plan("futures", "BTC", "USDT");
  assert.equal(btc.instrument, "BTC-USDT-PERP"); assert.equal(btc.fallback, "BTC-USD-SPOT"); assert.equal(btc.note, "");
  const ltc = plan("futures", "LTC", "USDT");
  assert.equal(ltc.instrument, "LTC-USDT-PERP"); assert.equal(ltc.fallback, "LTC-USD-SPOT");
});

test("spot: USDT markets map to the USD spot instrument", () => {
  assert.equal(plan("spot", "LTC", "USDT").instrument, "LTC-USD-SPOT");
  assert.equal(plan("spot", "TLTC", "USDTt").instrument, "LTC-USD-SPOT");
  assert.equal(plan("spot", "BTC", "USDT").instrument, "BTC-USD-SPOT");
  assert.equal(plan("spot", "sLTC", "USDT").instrument, "LTC-USD-SPOT");
  assert.equal(plan("spot", "sBTC", "USDT").instrument, "BTC-USD-SPOT");
});

test("TL against LTC or BTC shows the collateral asset, labelled", () => {
  for (const [kind, base, quote, inst] of [["futures", "TL", "LTC", "LTC-USD-SPOT"], ["spot", "TLt", "LTC", "LTC-USD-SPOT"], ["spot", "TL", "BTC", "BTC-USD-SPOT"]]) {
    const p = plan(kind, base, quote);
    assert.equal(p.state, "chart"); assert.equal(p.instrument, inst);
    assert.match(p.note, /no external market/);
  }
});

test("TL against USDT has no external market", () => {
  for (const kind of ["spot", "futures"]) {
    const p = plan(kind, "TL", "USDT");
    assert.equal(p.state, "none"); assert.equal(p.instrument, null); assert.match(p.note, /no external market/);
  }
  assert.equal(plan("spot", "TLt", "USDTt").state, "none");
});

test("cross pairs chart the base in USD with a note; unknown input is a no-chart state", () => {
  const p = plan("spot", "LTC", "BTC");
  assert.equal(p.instrument, "LTC-USD-SPOT"); assert.match(p.note, /No LTC\/BTC feed/);
  assert.equal(plan("spot", "", "").state, "none");
  assert.equal(plan("spot", "LTC", "LTC").state, "none");
});
