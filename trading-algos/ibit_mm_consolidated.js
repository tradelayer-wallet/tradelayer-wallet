/**
 * @algo-meta
 * {
 *   "name": "ibit_mm_consolidated",
 *   "description": "Market making strategy across BTC, LTC, and USDT pairs on IBIT, consolidating order book depth.",
 *   "mode": "SPOT",
 *   "market": "Multi-pair (BTC/LTC/USDT)",
 *   "exchange": "ibit",
 *   "instrument": "BTC,LTC",
 *   "counterAsset": "USDT"
 * }
 */
// ibit_mm_consolidated.js
// TL quoting + IBIT fair + options calendars + pre-close flatten + vol throttle + latency logs
// + USDC-M post-only hedger + calendar hedger integration (open/manage/rebalance + spread tighten).

import Alpaca from '@alpacahq/alpaca-trade-api';
import WebSocket from 'ws';
import fs from 'fs';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js'; dayjs.extend(utc);
import { TLAdapter } from './tlAdapter.js';
import { setMarketRefs, openDoubleCalendars, manageCalendars, rebalanceDeltaIfNeeded, spreadTightenFactor } from './calendarHedger.js';
import { placeMakerLimit, getExchangeInfo, roundTo as roundPerpTo } from './binanceHedge.js';

// ===== CONFIG =====
const IBIT = 'IBIT';
const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@trade';

const TL_PAIR = { type: 'SPOT', first_token: 0, second_token: 1 }; // set to your TL ids
const TL_QUOTE_SIZE_BTC = 0.05;

const BASE_SPREAD_BPS_RTH = 2.0;
const BASE_SPREAD_BPS_OFF = 5.0;

const INVENTORY_LIMIT_BTC = 1.0;
const K_EMA_ALPHA = 0.05;
const REQUOTE_TICK = 0.01;
const MAX_ORDER_AGE_SEC = 60;

// Auto-flatten window (ET). Start flattening minutes before 20:00 ET
const FLATTEN_START_MINUTES_BEFORE = 15;
const FLATTEN_SLIPPAGE_CENTS = 2;

// Volatility throttle
const VOL_WINDOW_SEC = 60;
const VOL_LEVELS = [50, 100, 200];
const VOL_MULTS  = [1.0, 1.5, 2.0, 3.0];

// Perp hedger (USDC-M)
const PERP_SYMBOL = process.env.BINANCE_PERP_SYMBOL || 'BTCUSDC';
let priceStep = 0.1;
let qtyStep = 0.001;

// ===== CLIENTS =====
const alpaca = new Alpaca({
  keyId: process.env.ALPACA_KEY_ID,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: /paper/.test(process.env.ALPACA_BASE_URL || ''),
  baseUrl: process.env.ALPACA_BASE_URL
});

const tl = new TLAdapter({
  wsUrl: process.env.TL_WS_URL || 'ws://172.81.181.19',
  port: Number(process.env.TL_PORT || 3001),
  test: true,
  tlAlreadyOn: true,
  myInfo: { address: process.env.TL_ADDRESS, otherAddrs: [] },
  chain: process.env.TL_CHAIN || 'LTCTEST'
});

// ===== STATE =====
let btcUsdt = 0;
let ibitNBBO = { bid: 0, ask: 0 };
let kFactor = 0;
let lastQuote = { bidPx: 0, askPx: 0, ts: 0 };
let positionShares = 0;
let btcTicks = [];

// ===== LOGGING =====
const LOG_PATH = process.env.LATENCY_LOG || './latency_log.csv';
let logSeq = 0;
function logLatency(evt, payload){
  try{
    const line = [++logSeq, new Date().toISOString(), evt, JSON.stringify(payload||{}).replace(/,/g,';')].join(',')+'\n';
    fs.appendFileSync(LOG_PATH, line);
  }catch{}
}

// ===== TIME HELPERS (ET) =====
function et(d=dayjs.utc()){ return d.subtract(4,'hour'); } // crude DST
function isWithinET(d, h1, h2){ const t=et(d); const v=t.hour()+t.minute()/60; return v>=h1 && v<h2; }
function isIBITOpen(d=dayjs.utc()){ return isWithinET(d, 4.0, 20.0); }
function isOptionsOpen(d=dayjs.utc()){ return isWithinET(d, 9.5, 16.25); }
function isFlattenWindow(d=dayjs.utc()){ const m=et(d).hour()*60+et(d).minute(); return m >= 20*60-FLATTEN_START_MINUTES_BEFORE && m<20*60; }

// ===== MATH =====
function bps(x){ return x/10000; }
function clamp(x,a,b){ return Math.max(a, Math.min(b,x)); }
function updateK(ibitMid){ if(!ibitMid||!btcUsdt) return; const obs=ibitMid/btcUsdt; if(!(obs>0)) return; kFactor = kFactor? (K_EMA_ALPHA*obs + (1-K_EMA_ALPHA)*kFactor) : obs; }
function fair(){ return (kFactor && btcUsdt) ? kFactor*btcUsdt : null; }
function sharesPerBTC(){ return kFactor ? (1/kFactor) : null; }
function btcFromShares(sh){ const spb=sharesPerBTC(); return spb ? (sh/spb) : 0; }
function round2(x){ return Math.round(x*100)/100; }

function updateVol(px){
  const now=Date.now();
  btcTicks.push({ts:now, px});
  const cutoff = now - VOL_WINDOW_SEC*1000;
  while(btcTicks.length && btcTicks[0].ts < cutoff) btcTicks.shift();
}
function sigmaUSD(){
  if(btcTicks.length<10) return 0;
  const xs=btcTicks.map(x=>x.px);
  const m = xs.reduce((a,b)=>a+b,0)/xs.length;
  const v = xs.reduce((a,b)=>a+(b-m)*(b-m),0)/xs.length;
  return Math.sqrt(v);
}
function spreadMult(){
  const s = sigmaUSD();
  if(s<VOL_LEVELS[0]) return VOL_MULTS[0];
  if(s<VOL_LEVELS[1]) return VOL_MULTS[1];
  if(s<VOL_LEVELS[2]) return VOL_MULTS[2];
  return VOL_MULTS[3];
}

// ===== STREAMS =====
function startBinanceWS(){
  const ws = new WebSocket(BINANCE_WS);
  ws.on('open', ()=>{ console.log('[binance] ws'); logLatency('binance_ws_open'); });
  ws.on('message', raw=>{
    try{ const m=JSON.parse(raw); if(m&&m.p){ btcUsdt=parseFloat(m.p); updateVol(btcUsdt); logLatency('binance_trade',{p:btcUsdt}); } }catch{}
  });
  ws.on('close', ()=>{ setTimeout(startBinanceWS, 3000); });
  ws.on('error', ()=>{});
}
startBinanceWS();

async function subscribeAlpacaQuotes(){
  const ws = alpaca.data_ws_v2;
  ws.onConnect(()=>{ ws.subscribeForQuotes([IBIT]); ws.subscribeForTrades([IBIT]); logLatency('alpaca_ws_open'); });
  ws.onStockQuote((q)=>{
    if(q.S!==IBIT) return;
    ibitNBBO = { bid:q.bp, ask:q.ap };
    const mid = (q.bp && q.ap) ? (q.bp+q.ap)/2 : 0;
    updateK(mid);
    // push refs to calendar module
    setMarketRefs({ k: kFactor, btc: btcUsdt, ibit_mid: mid });
    logLatency('ibit_quote', {bp:q.bp, ap:q.ap});
  });
  ws.onStockTrade((t)=> logLatency('ibit_trade',{p:t.p, s:t.s}));
  ws.connect();
}
subscribeAlpacaQuotes();

// ===== TL =====
async function initTL(){ await tl.init(); console.log('[TL] connected', tl.getAddress()); }
async function tlCancelAll(){ try{ await tl.cancelAll(); }catch(e){ console.log('[TL cancelAll]', e.message); } }

let lastTighten = 1.0;

async function tlQuote(){
  const f = fair();
  if(!f || !kFactor || !btcUsdt || !ibitNBBO.bid || !ibitNBBO.ask) return;

  const open = isIBITOpen(dayjs.utc());
  const base = open ? BASE_SPREAD_BPS_RTH : BASE_SPREAD_BPS_OFF;

  // Ask calendar hedger how much cushion we have → tighter spreads when covered
  try { lastTighten = await spreadTightenFactor(); } catch {}

  const sprBps = base * lastTighten * spreadMult();
  const half = f * bps(sprBps) / 2;

  let bidPx = Math.max(0.01, f - half);
  let askPx = f + half;

  // Stay inside IBIT NBBO for fair anchoring
  if(ibitNBBO.bid) bidPx = Math.min(bidPx, ibitNBBO.bid);
  if(ibitNBBO.ask) askPx = Math.max(askPx, ibitNBBO.ask);

  const moved = Math.abs(bidPx-lastQuote.bidPx)>=REQUOTE_TICK || Math.abs(askPx-lastQuote.askPx)>=REQUOTE_TICK;
  const stale = (Date.now() - (lastQuote.ts||0))/1000 > MAX_ORDER_AGE_SEC;
  if(!(moved||stale)) return;

  await tlCancelAll();

  // Inventory-aware sizing (uses IBIT share position as proxy for TL exposure limit)
  await refreshIbitPosition();
  const invBtc = btcFromShares(positionShares);
  const invStress = clamp(Math.abs(invBtc)/INVENTORY_LIMIT_BTC, 0, 1);
  const sizeBtc = TL_QUOTE_SIZE_BTC * (1 - 0.5*invStress);

  try{
    await tl.placeLimit({ pair: TL_PAIR, side:'buy',  price:Number(bidPx.toFixed(2)), amount:Number(sizeBtc.toFixed(6)) });
    await tl.placeLimit({ pair: TL_PAIR, side:'sell', price:Number(askPx.toFixed(2)), amount:Number(sizeBtc.toFixed(6)) });
    lastQuote = { bidPx, askPx, ts: Date.now() };
    logLatency('tl_quote', {bidPx, askPx, sprBps, tighten:lastTighten});
  }catch(e){
    console.log('[TL quote] error', e?.message);
  }
}

// ===== POSITIONS, FLATTEN, PERP HEDGE =====
async function refreshIbitPosition(){
  try{
    const pos = await alpaca.getPosition(IBIT).catch(()=>null);
    positionShares = pos ? Number(pos.qty) * (pos.side==='long' ? 1 : -1) : 0;
  }catch{}
}

async function flattenIfNeeded(){
  const now = dayjs.utc();
  if(!isFlattenWindow(now)) return;
  await tlCancelAll();
  await refreshIbitPosition();
  const qty = Math.abs(positionShares);
  if(qty===0 || !ibitNBBO.bid || !ibitNBBO.ask) return;

  const side = positionShares>0 ? 'sell' : 'buy';
  const px = side==='sell'
    ? Math.max(0.01, ibitNBBO.bid - FLATTEN_SLIPPAGE_CENTS/100)
    : ibitNBBO.ask + FLATTEN_SLIPPAGE_CENTS/100;
  try{
    await alpaca.cancelAllOrders().catch(()=>{});
    await alpaca.createOrder({ symbol:IBIT, side, type:'limit', time_in_force:'day', extended_hours:true, qty, limit_price:Number(px.toFixed(2)) });
    logLatency('flatten_submit',{side, qty, px});
  }catch(e){ console.log('[flatten]', e?.response?.data || e?.message); }
}

// Perp filters
async function initPerpFilters(){
  try{
    const ex = await getExchangeInfo(PERP_SYMBOL);
    const sym = (ex.symbols||[])[0];
    if(sym){
      const pf = sym.filters.find(f=>f.filterType==='PRICE_FILTER');
      const lf = sym.filters.find(f=>f.filterType==='LOT_SIZE');
      if(pf) priceStep = Number(pf.tickSize);
      if(lf) qtyStep = Number(lf.stepSize);
      console.log('[binance] filters', { priceStep, qtyStep });
    }
  }catch(e){ console.log('[binance] exchangeInfo', e.message); }
}

// Place post-only maker hedge on USDC-M
async function perpHedge(stepBtc){
  if(!btcUsdt) return;
  const side = stepBtc > 0 ? 'BUY' : 'SELL';
  const q = roundPerpTo(Math.abs(stepBtc), qtyStep);
  const nTicks = 2;
  let px = side==='BUY' ? (btcUsdt - nTicks*priceStep) : (btcUsdt + nTicks*priceStep);
  px = roundPerpTo(px, priceStep);
  try{
    await placeMakerLimit({ symbol: PERP_SYMBOL, side, quantity: q, price: px });
    logLatency('perp_order', { side, q, px });
  }catch(e){ console.log('[perp order]', e.message); }
}

// When IBIT shares are closed, calendarHedger handles step hedging via perps in its own function.
// We keep a safety hook here if you want additional hedging beyond calendars.
async function overnightSafetyHedge(){
  if(isIBITOpen()) return;
  // no-op: rely on calendarHedger.rebalanceDeltaIfNeeded()
}

// ===== MAIN LOOPS =====
async function main(){
  await initPerpFilters();
  await initTL();
  console.log('Consolidated MM online');

  // Open calendars once markets are live
  setInterval(async ()=>{
    if(isOptionsOpen()){
      try{ await openDoubleCalendars(); }catch(e){}
    }
  }, 30_000);

  // Keep calendars managed + delta rebalanced (shares during hours, perps off-hours inside the module)
  setInterval(async ()=>{
    try{
      await manageCalendars();
      await rebalanceDeltaIfNeeded();
    }catch{}
  }, 5_000);

  // Quote TL
  setInterval(tlQuote, 250);

  // Flatten near the bell
  setInterval(flattenIfNeeded, 5_000);
}

main();
