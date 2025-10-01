/**
 * @algo-meta
 * {
 *   "name": "calendarHedger",
 *   "description": "Calendar spread hedging strategy: balances exposure across futures expiries to reduce carry and volatility risk.",
 *   "mode": "FUTURES",
 *   "market": "BTC/ETH",
 *   "exchange": "binance",
 *   "instrument": "BTC,ETH",
 *   "counterAsset": "USDT"
 * }
 */

// calendarHedger.js
// A double-calendar spread hedger for IBIT options to back your TL quoting.
// Focus: competitive quoting by providing gamma/vega cushion with minimal fee churn.
// Uses Alpaca for options & shares, Binance USDC-M for overnight delta bridging (optional).

import Alpaca from '@alpacahq/alpaca-trade-api';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js'; dayjs.extend(utc);
import fetch from 'node-fetch';
import { placeMakerLimit as placePerpMaker, getExchangeInfo as perpExchangeInfo, roundTo as roundPerpTo } from './binanceHedge.js';

// ===== CONFIG =====
const IBIT = 'IBIT';
// Calendar design: short near (S) vs long far (L) expiries around OTM wings, symmetric calls/puts.
const STRIKE_OFFSETS = [+0.02, -0.02];      // ±2% from fair; adjust to 1–3% based on taste
const S_EXP_DAYS = 7;                        // short leg ~1W
const L_EXP_DAYS = 21;                       // long leg ~3W
const MAX_NET_DEBIT_PER_CAL = 0.95;          // do not open if net debit per calendar > $0.95/share
const TARGET_CAL_NOTIONAL_BTC = 0.50;        // target BTC exposure covered by calendars
const REBALANCE_DELTA_STEP_BTC = 0.10;       // rebalance when drift exceeds this
const MAX_GROSS_VEGA = 2.0;                  // max gross vega (in $/vol% per BTC equiv) before slowing adds
const SAIL_TO_EXPIRY_HOURS = 36;             // if short leg < 36h to expiry, prefer to sail
const ROLL_SKIP_FRIDAY = true;               // skip Friday rolls
const USE_PUT_SIDE = true;                   // include puts; set false for calls only

// Optional USDC-M perp bridging when shares closed
const USE_PERP_BRIDGE = true;
const PERP_SYMBOL = process.env.BINANCE_PERP_SYMBOL || 'BTCUSDC';

// ===== CLIENTS =====
const alpaca = new Alpaca({
  keyId: process.env.ALPACA_KEY_ID,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: /paper/.test(process.env.ALPACA_BASE_URL || ''),
  baseUrl: process.env.ALPACA_BASE_URL
});

// ===== TIME HELPERS =====
function toET(d=dayjs.utc()){ return d.subtract(4,'hour'); } // simple ET = UTC-4 (adjust for DST in prod)
function isOptionsOpen(d=dayjs.utc()){ return toET(d).hour()+toET(d).minute()/60 >= 9.5 && toET(d).hour()+toET(d).minute()/60 < 16.25; }
function isSharesOpen(d=dayjs.utc()){ const h=toET(d).hour()+toET(d).minute()/60; return h>=4 && h<20; }
function isFriday(d=dayjs.utc()){ return toET(d).day() === 5; }

// ===== STATE =====
let kFactor = 0;              // IBIT/BTC factor for strike targeting (set elsewhere in your main process)
let btcUsdt = 0;              // last Binance price (set externally or inject)
let ibitMid = 0;              // updated from NBBO
let openCalendars = [];       // [{side:'C'|'P', shortExp, longExp, strike, qtyContracts, avgDebit}]
let perpFilters = { priceStep: 0.1, qtyStep: 0.001 };

export function setMarketRefs({ k, btc, ibit_mid }){
  if (k) kFactor = k;
  if (btc) btcUsdt = btc;
  if (ibit_mid) ibitMid = ibit_mid;
}

async function initPerpFilters(){
  try{
    const ex = await perpExchangeInfo(PERP_SYMBOL);
    const sym = (ex.symbols||[])[0];
    if(sym){
      const priceFilter = sym.filters.find(f=>f.filterType==='PRICE_FILTER');
      const lotFilter = sym.filters.find(f=>f.filterType==='LOT_SIZE');
      if(priceFilter) perpFilters.priceStep = Number(priceFilter.tickSize);
      if(lotFilter) perpFilters.qtyStep = Number(lotFilter.stepSize);
    }
  }catch{}
}

// ===== HELPERS =====
function targetPrice(){ return (kFactor && btcUsdt) ? kFactor * btcUsdt : null; }
function round2(x){ return Math.round(x*100)/100; }
function sharesPerBTC(){ return kFactor ? (1/kFactor) : null; }
function contractsForBtc(btc){ const spb = sharesPerBTC(); return spb ? Math.round((btc*spb)/100) : 0; } // 1 contract = 100 sh
function nowET(){ return toET(dayjs.utc()).format('YYYY-MM-DD HH:mm:ss'); }

// Basic greeks proxy (for gating adds only, not precision): vega per 1% ≈ 0.06–0.1 * price in $ per contract near ATM
function roughVegaPerContract(price){ return Math.max(0.05*price, 0.5); } // $/vol%

// ===== ALPACA OPTIONS HELPERS =====
// WARNING: Alpaca's options complex orders are limited. We emulate a "combo" by legging quickly and checking net debit caps.
// Replace with true multi-leg if/when supported in your plan.
async function listOptionsContracts({symbol, expirationDate}){
  // Alpaca SDK exposes data via /v2/options/contracts
  const url = `${alpaca.configuration.baseUrl}/v2/options/contracts?underlying_symbol=${symbol}&expiration_date=${expirationDate}`;
  const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': alpaca.keyId, 'APCA-API-SECRET-KEY': alpaca.secretKey } });
  const j = await res.json();
  return j?.data || [];
}

async function placeOptionOrder({symbol, qty, side, type='limit', limit_price, option_symbol}){
  const url = `${alpaca.configuration.baseUrl}/v2/options/orders`;
  const body = {
    symbol, qty, side, type,
    time_in_force: 'day',
    limit_price: Number(limit_price.toFixed(2)),
    option_symbol
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'APCA-API-KEY-ID': alpaca.keyId, 'APCA-API-SECRET-KEY': alpaca.secretKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`options order err ${res.status}: ${txt}`);
  try { return JSON.parse(txt); } catch { return txt; }
}

async function cancelAllOptions(){
  const url = `${alpaca.configuration.baseUrl}/v2/options/orders`;
  await fetch(url, { method: 'DELETE', headers: { 'APCA-API-KEY-ID': alpaca.keyId, 'APCA-API-SECRET-KEY': alpaca.secretKey } });
}

// Get current NBBO mid for an option symbol (for quick pricing/guardrails)
async function getOptionQuoteMid(option_symbol){
  const url = `${alpaca.configuration.baseUrl}/v2/options/quotes/latest?option_symbol=${option_symbol}`;
  const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': alpaca.keyId, 'APCA-API-SECRET-KEY': alpaca.secretKey } });
  const j = await res.json();
  const q = j?.quote;
  if (!q) return null;
  if (q.ap && q.bp) return (Number(q.ap) + Number(q.bp))/2;
  return Number(q.ap || q.bp || 0);
}

// ===== CONTRACT SYMBOLING =====
function yyyymmdd(d){ return d.format('YYYY-MM-DD'); }
function toOccStrike(strike){ return Math.round(strike*1000)/1000; } // OCC uses 3 decimals; Alpaca symbol builder handles it
function buildOptionSymbol({underlying=IBIT, exp, right, strike}){
  // Alpaca accepts OCC sym like IBIT   241010C00065000; we’ll rely on API by passing option_symbol from contract list.
  return { underlying, exp, right, strike };
}

// Find closest strikes and expiries
function pickCalendarTargets() {
  const fair = targetPrice(); if (!fair) return null;
  const S = fair;
  const result = [];

  const now = dayjs.utc();
  const sExp = now.add(S_EXP_DAYS, 'day');
  const lExp = now.add(L_EXP_DAYS, 'day');

  for (const off of STRIKE_OFFSETS) {
    const strike = round2(S * (1 + off));
    result.push({ right:'C', strike, shortExp: sExp, longExp: lExp });
    if (USE_PUT_SIDE) result.push({ right:'P', strike: round2(S * (1 - off)), shortExp: sExp, longExp: lExp });
  }
  return result;
}

// ===== ENTRY / MANAGEMENT =====
export async function openDoubleCalendars(){
  if (!isOptionsOpen()) return { ok:false, reason:'options closed' };
  const targets = pickCalendarTargets(); if (!targets) return { ok:false, reason:'no targets' };

  // Determine how many contracts to open to cover TARGET_CAL_NOTIONAL_BTC
  const perBtcContracts = contractsForBtc(1);
  const targetContracts = Math.max(1, Math.round(contractsForBtc(TARGET_CAL_NOTIONAL_BTC) / targets.length));

  for (const t of targets) {
    // Find contract ids from Alpaca list
    const sList = await listOptionsContracts({ symbol: IBIT, expirationDate: yyyymmdd(t.shortExp) });
    const lList = await listOptionsContracts({ symbol: IBIT, expirationDate: yyyymmdd(t.longExp) });
    const sideKey = t.right === 'C' ? 'call' : 'put';

    const s = sList.find(o => Number(o.strike_price).toFixed(2) == t.strike.toFixed(2) && o.right.toLowerCase() === sideKey);
    const l = lList.find(o => Number(o.strike_price).toFixed(2) == t.strike.toFixed(2) && o.right.toLowerCase() === sideKey);
    if (!s || !l) { console.log('[calendar] contract not found', t); continue; }

    const sMid = await getOptionQuoteMid(s.symbol);
    const lMid = await getOptionQuoteMid(l.symbol);
    if (!sMid || !lMid) { console.log('[calendar] missing quotes', t); continue; }

    const estDebit = lMid - sMid;
    if (estDebit > MAX_NET_DEBIT_PER_CAL) {
      console.log('[calendar] skip, debit too high', s.symbol, l.symbol, estDebit);
      continue;
    }

    // Emulate a combo: buy long @ limit ~ lMid, sell short @ limit ~ sMid; guard on net debit
    const qty = targetContracts;
    try{
      const buyL = await placeOptionOrder({ symbol: IBIT, qty, side:'buy',  limit_price: lMid, option_symbol: l.symbol });
      const sellS = await placeOptionOrder({ symbol: IBIT, qty, side:'sell', limit_price: sMid, option_symbol: s.symbol });
      openCalendars.push({ side:t.right, shortExp: yyyymmdd(t.shortExp), longExp: yyyymmdd(t.longExp), strike:t.strike, qtyContracts: qty, avgDebit: estDebit });
      console.log(`[calendar] OPEN ${t.right} ${t.strike} S:${yyyymmdd(t.shortExp)} vs L:${yyyymmdd(t.longExp)} qty=${qty} debit≈${estDebit.toFixed(2)}`);
    }catch(e){
      console.log('[calendar] open error', e.message);
      // Attempt to back out if only one leg filled: (production would check fills and reverse if needed)
    }
  }
  return { ok:true };
}

export async function manageCalendars(){
  // Sail short into expiry when within SAIL_TO_EXPIRY_HOURS; avoid rolls on Friday if configured
  const now = dayjs.utc();
  for (const c of openCalendars) {
    const shortExp = dayjs.utc(c.shortExp + 'T20:00:00Z'); // approx market close of that day
    const hoursLeft = shortExp.diff(now, 'hour', true);
    if (hoursLeft <= SAIL_TO_EXPIRY_HOURS) {
      // Do nothing: let short decay; consider profit-take on long if IV spikes
      continue;
    }
    if (ROLL_SKIP_FRIDAY && isFriday(now)) continue;
    // Otherwise, you could evaluate a roll: close current short, open next S_EXP_DAYS forward.
    // To keep churn low, we simply defer rolls until inside the sail window.
  }
}

export async function currentExposure(){
  // Rough exposure metrics for spread-tightening logic in TL:
  // Sum vega, theta proxy, delta from net option positions, then decide if quoting can tighten.
  // Here we only compute calendar count * rough vega per contract.
  let grossVega = 0;
  for (const c of openCalendars) {
    // Use last known long price as proxy for vega
    try{
      const lList = await listOptionsContracts({ symbol: IBIT, expirationDate: c.longExp });
      const sideKey = c.side === 'C' ? 'call' : 'put';
      const l = lList.find(o => Number(o.strike_price).toFixed(2) == c.strike.toFixed(2) && o.right.toLowerCase() === sideKey);
      const lMid = l ? await getOptionQuoteMid(l.symbol) : 0.0;
      const vegaPer = roughVegaPerContract(lMid);
      grossVega += vegaPer * c.qtyContracts;
    }catch{}
  }
  return { grossVega };
}

// ===== DELTA REBALANCE =====
export async function rebalanceDeltaIfNeeded(){
  // Read IBIT share position and hedge toward 0 in steps when shares are open; otherwise use perps
  const pos = await alpaca.getPosition(IBIT).catch(()=>null);
  const shares = pos ? Number(pos.qty) * (pos.side==='long' ? 1 : -1) : 0;
  const spb = sharesPerBTC() || 0;
  const invBtc = spb ? (shares / spb) : 0;

  if (Math.abs(invBtc) < REBALANCE_DELTA_STEP_BTC) return;

  const step = -Math.sign(invBtc) * REBALANCE_DELTA_STEP_BTC;

  if (isSharesOpen()) {
    // Hedge with IBIT shares (cheap). Marketable small limit to ensure fill.
    try{
      const quote = await alpaca.getLatestQuote(IBIT);
      const px = step > 0 ? (quote.ap + 0.01) : (quote.bp - 0.01);
      await alpaca.createOrder({ symbol: IBIT, side: step>0?'buy':'sell', type:'limit', time_in_force:'day', extended_hours:true, qty: Math.round(Math.abs(step)*spb), limit_price: round2(px) });
      console.log('[delta] hedged via shares', step, 'BTC');
    }catch(e){
      console.log('[delta] share hedge err', e.message);
    }
  } else if (USE_PERP_BRIDGE && btcUsdt) {
    // Use USDC-M post-only maker
    try{
      // lazy load filters once
      if (!perpFilters._init){ await initPerpFilters(); perpFilters._init = true; }
      const side = step>0 ? 'BUY' : 'SELL';
      let q = roundPerpTo(Math.abs(step), perpFilters.qtyStep);
      const nTicks = 2;
      let px = step>0 ? (btcUsdt - nTicks*perpFilters.priceStep) : (btcUsdt + nTicks*perpFilters.priceStep);
      px = roundPerpTo(px, perpFilters.priceStep);
      await placePerpMaker({ symbol: PERP_SYMBOL, side, quantity: q, price: px });
      console.log('[delta] hedged via perps', step, 'BTC @', px);
    }catch(e){
      console.log('[delta] perp hedge err', e.message);
    }
  }
}

// ===== PUBLIC: tighten suggestion for TL spreads =====
export async function spreadTightenFactor(){
  // Return (0,1] multiplier to apply to TL spreads: tighter when gross vega/coverage is good.
  const { grossVega } = await currentExposure();
  if (grossVega <= 0.2) return 1.0;    // little cushion
  if (grossVega <= 0.5) return 0.85;
  if (grossVega <= 1.0) return 0.70;
  if (grossVega <= MAX_GROSS_VEGA) return 0.60;
  return 0.50; // very cushioned
}
