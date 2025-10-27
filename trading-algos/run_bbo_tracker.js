'use strict';
/**
 * bbo_tracker_hf.js
 * Keeps exactly 2 live orders (1 BUY at best bid, 1 SELL at best ask).
 * - Cancels & replaces on >= TICK_TOL ticks of movement.
 * - Per-side sequencing so cancels/places never overlap.
 * - Token-bucket rate limit to avoid flooding server.
 * - Skips updates if Binance BBO is stale.
 * - Logs Binance BBO and every place/cancel.
 *
 * Requires:
 *   - ccxt installed (for Binance ticker).
 *   - ./algoAPI.js exposing class ApiWrapper with:
 *       - constructor(host, port, debug, autoConnect, {address, otherAddrs}, network)
 *       - sendOrder(orderDetails) -> Promise<string> (UUID)
 *       - cancelOrder(uuid) -> Promise<void>
 *
 * Run: node run_bbo_tracker.js
 */

// ---- Algo Env Header (paste at top) ---------------------------------

const pick = (...xs) => xs.find(v => v !== undefined && v !== '') ?? undefined;
const toBool = (v, d=false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));
const toNum  = (v, d) => (v === undefined ? d : Number(v));

const required = (label, ...candidates) => {
  const v = pick(...candidates);
  if (v === undefined) throw new Error(`Missing env: ${label}`);
  return v;
};

// Source envs (prefer TL_*, fallback to legacy)
const TL_HOST    = pick(process.env.TL_HOST,    process.env.OB_HOST);
const TL_PORT    = pick(process.env.TL_PORT,    process.env.OB_PORT);
const TL_TEST    = pick(process.env.TL_TEST,    process.env.IS_TESTNET); // 'true'|'false' or '1'|'0'
const TL_ADDR    = pick(process.env.TL_ADDRESS, process.env.USER_ADDR);
const TL_PUB     = pick(process.env.TL_PUBKEY,  process.env.USER_PUB);
const TL_NET     = pick(process.env.TL_NETWORK, process.env.NETWORK);

// Optional sizing
const SIZE       = pick(process.env.SIZE, process.env.QTY, process.env.TARGET_EXPOSURE, process.env.QUICKENVJS_TARGET_EXPOSURE);

// Build normalized config
const CFG = Object.freeze({
  NETWORK: required('TL_NETWORK/NETWORK', TL_NET),
  HOST:    required('TL_HOST/OB_HOST', TL_HOST),
  PORT:    toNum(required('TL_PORT/OB_PORT', TL_PORT), 3001),
  TESTNET: toBool(TL_TEST, true),           // accepts 'true'/'1'/'false'/'0'
  ADDRESS: required('TL_ADDRESS/USER_ADDR', TL_ADDR),
  PUBKEY:  required('TL_PUBKEY/USER_PUB',   TL_PUB),
  SIZE:    toNum(SIZE, 0.1),

  // Derived
  ORDERBOOK_WS() {                          // ws URL builder
    const host = this.HOST.startsWith('ws') ? this.HOST : `ws://${this.HOST}`;
    return `${host}:${this.PORT}/ws`;
  }
});

// Optional: one-time sanity log
console.log('[env-check]', {
  NETWORK: CFG.NETWORK,
  HOST: CFG.HOST, PORT: CFG.PORT,
  TESTNET: CFG.TESTNET,
  ADDRESS: CFG.ADDRESS,
  PUBKEY: (CFG.PUBKEY || '').slice(0, 8) + '…',
  SIZE: CFG.SIZE,
  WS: CFG.ORDERBOOK_WS(),
});

// Export or attach where needed
global.CFG = CFG;

// ---------------------------------------------------------------------


const ccxt = require('ccxt');
const ApiWrapper = require('./algoAPI.js');

// ===== Config =====
const CFG = {
  // TL / server
  TL_WS_HOST: 'ws://172.26.37.103',
  TL_WS_PORT: 3001,
  TL_NETWORK: 'LTCTEST',
  TL_ADDR: 'tltc1qn006lvcx89zjnhuzdmj0rjcwnfuqn7eycw40yf',
  TL_PUB: '03670d8f2109ea83ad09142839a55c77a6f044dab8cb8724949931ae8ab1316677',

  BASE_ID: 0,    // LTC
  QUOTE_ID: 5,   // USDTt

  // Market source
  SYMBOL_CCXT: 'LTC/USDT',

  // Behavior
  POLL_MS: 50,              // Binance poll interval
  SIZE: 0.10,               // order size
  TICK: 0.0001,             // price tick
  EDGE_BPS: 0.0,            // pad off BBO (0 = exact mirror)

  // HF stability
  STALE_MS: 250,            // if BBO older than this, skip
  MIN_REPLACE_MS: 50,       // min gap per-side between replaces
  TICK_TOL: 1.0,            // require >= this many ticks to replace
  MAX_OPS_PER_SEC: 200,     // global cap (place+cancel) across both sides
  CANCEL_PLACE_GAP_MS: 10,  // small delay after cancel before place

  // Timeouts
  PLACE_TIMEOUT_MS: 5000,
  CANCEL_TIMEOUT_MS: 5000,
};

// ===== Helpers =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const bps = (x) => x / 10000.0;
const roundDown = (x, tick) => Math.floor(x / tick) * tick;
const roundUp   = (x, tick) => Math.ceil(x / tick) * tick;
const num = (v, d=8) => Number(Number(v).toFixed(d));

async function withTimeout(p, ms, tag) {
  let t; const killer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${tag||'op'} timeout`)), ms); });
  try { return await Promise.race([p, killer]); } finally { clearTimeout(t); }
}

function pxChanged(oldPx, newPx, tick, tolTicks) {
  if (oldPx == null) return true;
  return Math.abs(oldPx - newPx) >= tick * tolTicks;
}

// ===== TL order builders (canonical TL shape via props) =====
function toTLBuy(cfg, price, amount) {
  return {
    type: 'SPOT',
    action: 'BUY',
    keypair: {
    address: cfg.TL_ADDR,
    pubkey: cfg.TL_PUB
    },
    props: {
      id_for_sale: cfg.BASE_ID,   // selling quote (USDTt)
      id_desired:  cfg.QUOTE_ID,    // buying base (TLTC)
      price: Number(price),
      amount: Number(amount),
      transfer: false
    },
    isLimitOrder: true
  };
}

function toTLSell(cfg, price, amount) {
  return {
    type: 'SPOT',
    action: 'SELL',
    keypair: {
    address: cfg.TL_ADDR,
    pubkey: cfg.TL_PUB
    },
    props: {
      id_for_sale: cfg.QUOTE_ID,    // selling base (TLTC)
      id_desired:  cfg.BASE_ID,   // receiving quote (USDTt)
      price: Number(price),
      amount: Number(amount),
      transfer: false
    },
    isLimitOrder: true
  };
}


// ===== External deps =====
const binance = new ccxt.binance({ enableRateLimit: true });
const api = new ApiWrapper(
  CFG.TL_WS_HOST,
  CFG.TL_WS_PORT,
  true,                 // debug (or tlOn) — unchanged
  true,                 // autoConnect      — unchanged
  CFG.TL_ADDR,
  CFG.TL_PUB,
  CFG.TL_NETWORK
);

// ===== Token-bucket rate limiter =====
class TokenBucket {
  constructor(rps) { this.capacity = rps; this.tokens = rps; this.last = Date.now(); }
  take(n = 1) {
    const now = Date.now();
    const dt = (now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.capacity);
    this.last = now;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}
const bucket = new TokenBucket(CFG.MAX_OPS_PER_SEC);

// ===== State =====
let live = { BUY: null, SELL: null };      // { uuid, px }
let sideBusy = { BUY: false, SELL: false };// per-side sequencing lock
let sideLast = { BUY: 0, SELL: 0 };        // last replace time per-side
let lastBBO = { bid: null, ask: null };
let lastBBOts = 0;

// ===== TL ops =====
async function place(side, px, sz) {
  if (sideBusy[side]) return;
  if (!bucket.take()) return;
  sideBusy[side] = true;
  try {
    const det = side === 'BUY' ? toTLBuy(CFG, px, sz) : toTLSell(CFG, px, sz);
    console.log('[TL] sendOrder request', det);
    const uuid = await withTimeout(api.sendOrder(det), CFG.PLACE_TIMEOUT_MS, 'place');
    const id = uuid?.orderUuid || uuid;
    live[side] = { uuid: id, px };
    sideLast[side] = Date.now();
    console.log('PLACED', side, num(px, 6), 'uuid=', id);
  } catch (e) {
    console.log('PLACE FAIL', side, px, e?.message || e);
  } finally {
    sideBusy[side] = false;
  }
}

async function cancel(side, reason) {
  const cur = live[side];
  if (!cur?.uuid) return;
  if (sideBusy[side]) return;
  if (!bucket.take()) return;
  sideBusy[side] = true;
  try {
    await withTimeout(api.cancelOrder(cur.uuid), CFG.CANCEL_TIMEOUT_MS, 'cancel');
    console.log('CANCELED', side, num(cur.px, 6), 'uuid=', cur.uuid, 'reason=', reason);
    live[side] = null;
  } catch (e) {
    console.log('CANCEL FAIL', side, cur.uuid, e.message || e);
  } finally {
    sideBusy[side] = false;
  }
}

function targetsFromBBO(bid, ask) {
  const b = Math.max(0, roundDown(bid * (1 - (CFG.EDGE_BPS / 10000.0)), CFG.TICK));
  const a = Math.max(0, roundUp(  ask * (1 + (CFG.EDGE_BPS / 10000.0)), CFG.TICK));
  return { buyPx: b, sellPx: a };
}

// ===== Main loop =====
async function tickOnce() {
  // 1) Fetch BBO
  const tkr = await binance.fetchTicker(CFG.SYMBOL_CCXT);
  const bid = Number(tkr.bid), ask = Number(tkr.ask);
  if (!isFinite(bid) || !isFinite(ask)) return;
  lastBBO = { bid, ask }; lastBBOts = Date.now();
  console.log(`[BINANCE] ${CFG.SYMBOL_CCXT} bid=${bid} ask=${ask}`);

  // 2) Freshness check
  if (Date.now() - lastBBOts > CFG.STALE_MS) return;

  // 3) Compute targets
  const { buyPx, sellPx } = targetsFromBBO(bid, ask);

  // 4) BUY side replace logic
  if (!sideBusy.BUY) {
    const old = live.BUY?.px ?? null;
    const ageOk = Date.now() - sideLast.BUY >= CFG.MIN_REPLACE_MS;
    if (ageOk && pxChanged(old, buyPx, CFG.TICK, CFG.TICK_TOL)) {
      await cancel('BUY', 'replace');
      if (CFG.CANCEL_PLACE_GAP_MS) await sleep(CFG.CANCEL_PLACE_GAP_MS);
      await place('BUY', buyPx, CFG.SIZE);
    }
  }

  // 5) SELL side replace logic
  if (!sideBusy.SELL) {
    const old = live.SELL?.px ?? null;
    const ageOk = Date.now() - sideLast.SELL >= CFG.MIN_REPLACE_MS;
    if (ageOk && pxChanged(old, sellPx, CFG.TICK, CFG.TICK_TOL)) {
      await cancel('SELL', 'replace');
      if (CFG.CANCEL_PLACE_GAP_MS) await sleep(CFG.CANCEL_PLACE_GAP_MS);
      await place('SELL', sellPx, CFG.SIZE);
    }
  }
}

(async () => {
  console.log('Starting BBO tracker (2 orders, HF-stable)…');
  while (true) {
    try {
      await tickOnce();
    } catch (e) {
      console.log('Loop error:', e.message || e);
    }
    await sleep(CFG.POLL_MS);
  }
})();
