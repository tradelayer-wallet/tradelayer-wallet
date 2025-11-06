// spam_screamer.js
'use strict';

require('dotenv').config();
const WebSocket = require('ws');

// prefer local ./tl, fall back to npm 'tradelayer'
let ApiWrapper;
try {
  ApiWrapper = require('./tl');
} catch {
  ApiWrapper = require('tradelayer');
}

// ---- helpers ----
const toBool = (v, d = false) =>
  v === undefined
    ? d
    : ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());

const required = (name, def) => {
  const v = process.env[name] ?? def;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
};

// ---- ENV CONFIG ----
const HOST    = required('TL_HOST', 'ws.layerwallet.com');
const PORT    = Number(process.env.TL_PORT ?? 443);
const TESTNET = toBool(process.env.TL_TEST, true);
const TL_ON   = toBool(process.env.TL_TLON, true);

const ADDRESS = required(
  'TL_ADDRESS',
  'tltc1qn006lvcx89zjnhuzdmj0rjcwnfuqn7eycw40yf'
);
const PUBKEY  = required(
  'TL_PUBKEY',
  '03670d8f2109ea83ad09142839a55c77a6f044dab8cb8724949931ae8ab1316677'
);
const NETWORK = required('TL_NETWORK', 'LTCTEST');

const SIZE          = Number(required('SIZE', 0.1));
const SPAM_RPS      = Number(process.env.SPAM_RPS ?? 10);
const MAX_IN_FLIGHT = Number(process.env.MAX_IN_FLIGHT ?? 200);

const ID_FOR_SALE   = Number(process.env.ID_FOR_SALE ?? 0);
const ID_DESIRED    = Number(process.env.ID_DESIRED ?? 5);

console.log(
  '[env]',
  { HOST, PORT, TESTNET, TL_ON, ADDRESS, PUBKEY, NETWORK, SIZE, SPAM_RPS, MAX_IN_FLIGHT }
);

// ---- INIT API ----
const api = new ApiWrapper(HOST, PORT, TESTNET, TL_ON, ADDRESS, PUBKEY, NETWORK);

// ---- Binance WebSocket feed (LTC/USDT) ----
const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws/ltcusdt@depth20@100ms';
const LEVEL_OFFSET   = Number(process.env.LEVEL_OFFSET ?? 2);

let lastBook = { bids: [], asks: [] };
let bookReady = false;

function startBinanceFeed() {
  const ws = new WebSocket(BINANCE_WS_URL);
  ws.on('open', () => console.log('[binance] connected'));
  ws.on('message', msg => {
    const data = JSON.parse(msg);
    if (!data.bids || !data.asks) return;
    lastBook = {
      bids: data.bids.map(([p, q]) => [Number(p), Number(q)]),
      asks: data.asks.map(([p, q]) => [Number(p), Number(q)]),
    };
    bookReady = true;
  });
  ws.on('close', () => {
    console.warn('[binance] socket closed, retrying...');
    setTimeout(startBinanceFeed, 2000);
  });
  ws.on('error', e => console.error('[binance] error', e.message));
}

function pickPrice(action) {
  if (!bookReady) return null;
  if (action === 'BUY') {
    const asks = lastBook.asks;
    const idx = Math.min(LEVEL_OFFSET, asks.length - 1);
    return asks[idx]?.[0];
  } else {
    const bids = lastBook.bids;
    const idx = Math.min(LEVEL_OFFSET, bids.length - 1);
    return bids[idx]?.[0];
  }
}

// ---- Build TL order ----
function buildOrder(action, price) {
  return {
    type: 'SPOT',
    action,
    // Set as limit order pegged to Binance depth
    isLimitOrder: true,
    keypair: {
      address: ADDRESS,
      pubkey: PUBKEY,
    },
    props: {
      id_for_sale: ID_FOR_SALE,
      id_desired: ID_DESIRED,
      price,
      amount: SIZE,
      transfer: false,
    },
  };
}

// ---- SPAMMER STATE ----
let inflight = 0;
let sent = 0;
let failed = 0;
let seq = 0;
let running = true;

const delay = ms => new Promise(res => setTimeout(res, ms));

async function fireOne() {
  if (!running) return;
  if (inflight >= MAX_IN_FLIGHT) return;
  if (!bookReady) return; // wait until we have a book

  inflight++;
  sent++;
  const n = seq++;
  const action = n % 2 === 0 ? 'BUY' : 'SELL';
  const price = pickPrice(action);
  if (!price) {
    inflight--;
    return;
  }

  const order = buildOrder(action, price);
  const t0 = Date.now();

  try {
    const uuid = await api.sendOrder(order);
    const dt = Date.now() - t0;
    if (n % 50 === 0) {
      console.log(
        `[ok] #${n} ${action} price=${price.toFixed(4)} uuid=${uuid} latency=${dt}ms inflight=${inflight} sent=${sent} failed=${failed}`
      );
    }
  } catch (e) {
    failed++;
    console.error(
      `[err] #${n} ${action} inflight=${inflight} sent=${sent} failed=${failed} msg=${e?.message || e}`
    );
  } finally {
    inflight--;
  }
}

async function main() {
  console.log('[cfg] connecting...', { HOST, PORT, TESTNET, TL_ON, NETWORK });
  startBinanceFeed();
  await api.delay(1500);

  try {
    const me = api.getMyInfo?.();
    if (me?.address) console.log('[me]', me.address);
  } catch {}

  console.log(`[spam] starting screamer: SPAM_RPS=${SPAM_RPS}, MAX_IN_FLIGHT=${MAX_IN_FLIGHT}, SIZE=${SIZE}`);

  const intervalMs = 1000 / Math.max(SPAM_RPS, 1);
  const interval = setInterval(() => {
    if (!running) return;
    fireOne(); // fire-and-forget
  }, intervalMs);

  const shutdown = async () => {
    if (!running) return;
    running = false;
    clearInterval(interval);
    console.log('[shutdown] waiting for inflight orders to finish...');
    while (inflight > 0) {
      console.log(`[shutdown] inflight=${inflight} ...`);
      await delay(500);
    }
    console.log(`[stats] sent=${sent}, failed=${failed}, max_inflight=${MAX_IN_FLIGHT}`);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => {
  console.error('[fatal]', e);
  process.exit(1);
});
