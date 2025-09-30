/**
 * @algo-meta
 * {
 *   "name": "gamma_hedged_ma_scalper",
 *   "description": "Gamma-hedged moving average scalper: combines moving averages with gamma hedging for balanced futures exposure.",
 *   "mode": "FUTURES",
 *   "market": "BTC/USDT",
 *   "exchange": "Alpaca",
 *   "instrument": "BTC",
 *   "counterAsset": "USDT"
 * }
 */

/*
  Gamma-Hedged MA Scalper (5m)
  ---------------------------------
  • Signals: EMA stack on 5m (21/34/55/89/144)
  • Entries: staggered (ladder) maker orders in trend direction
  • Risk: trailing stops per leg (ATR(14) on 5m), daily loss cap, max concurrent legs
  • Hedge budget: total net delta from scalps capped by option backspread gamma
      — capacity ~ k * |Gamma| * S * dS_max (delta created by a dS move)
  • Backspread: assumed pre-built elsewhere; we poll live Greeks for net Γ and Θ

  Glue points you must implement:
    - MarketAdapter (price/candles/orders)
    - OptionsAdapter (portfolio Greeks)

  This file keeps things self-contained so you can drop it into your project.
*/

import dayjs from "dayjs";

/************************** Types & Config **************************/

type Side = "LONG" | "SHORT";

type Candle = { ts: number; o: number; h: number; l: number; c: number; v?: number };

type Order = {
  id?: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  limitPrice: number;
  tif?: "GTC" | "IOC";
  postOnly?: boolean;
};

type Fill = { orderId: string; ts: number; px: number; qty: number; side: "BUY" | "SELL" };

type Position = { symbol: string; qty: number; avgPx: number };

type Greeks = { delta: number; gamma: number; theta: number; vega?: number };

interface MarketAdapter {
  fetchCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  bestBidAsk(symbol: string): Promise<{ bid: number; ask: number }>;
  placeOrder(o: Order): Promise<{ orderId: string }>;
  cancelOrder(orderId: string): Promise<void>;
  openOrders(symbol: string): Promise<Order[]>;
  position(symbol: string): Promise<Position | null>;
  now(): number; // ms
}

interface OptionsAdapter {
  portfolioGreeks(underlying: string): Promise<Greeks>; // net greeks of your backspread book
}

const CFG = {
  symbol: process.env.UNDERLYING || "BTC-PERP", // hedge/trade instrument on your venue
  underlyingForGreeks: process.env.UNDERLYING_BASE || "BTC",
  interval: "5m",
  maLens: [21, 34, 55, 89, 144],
  atrLen: 14,
  ladder: {
    legs: 4, // how many staggered entries
    stepBps: 3, // each next leg placed deeper by this many bps from mid in trend dir (maker)
    baseQty: 0.01, // contracts per leg (adjust to your instrument)
    maxConcurrent: 6,
  },
  trailing: {
    atrMult: 1.8, // stop trails by N * ATR
    minTrailBps: 6, // floor on trailing gap (bps)
  },
  gammaCap: {
    dSmaxPct: 0.50, // max underlying move you plan to tolerate for delta calc (e.g., 50 bps intraday band)
    k: 0.9, // fraction of theoretical capacity to allow (safety)
  },
  risk: {
    dailyLossCapUsd: -300, // flatten & stop if breached
    maxNotionalUsd: 25000,
  },
  execution: {
    postOnly: true,
    tif: "GTC" as const,
    tickSize: 0.01, // adjust per venue
    bps(n: number, px: number) { return +(px * n / 10000).toFixed(2); },
  },
};

/************************** Indicators **************************/

function ema(values: number[], len: number): number[] {
  const k = 2 / (len + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = i === 0 ? v : k * v + (1 - k) * prev;
    out.push(prev);
  }
  return out;
}

function atr(c: Candle[], len: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < c.length; i++) {
    if (i === 0) { out.push(c[i].h - c[i].l); continue; }
    const tr = Math.max(
      c[i].h - c[i].l,
      Math.abs(c[i].h - c[i - 1].c),
      Math.abs(c[i].l - c[i - 1].c)
    );
    out.push(tr);
  }
  // smooth with EMA len
  return ema(out, len);
}

/************************** Strategy State **************************/

type Leg = {
  id: string; side: Side; entryPx: number; qty: number; openTs: number;
  trailingStop: number; lastPeak: number; // for LONG peak=high-water; for SHORT peak=low-water
};

class Scalper {
  private legs: Leg[] = [];
  private dailyPnL = 0;

  constructor(private m: MarketAdapter, private opt: OptionsAdapter) {}

  private snapPnl(px: number) {
    // Simple mark-to-market versus entryPx for open legs
    let pnl = 0;
    for (const L of this.legs) {
      const dir = L.side === "LONG" ? 1 : -1;
      pnl += dir * (px - L.entryPx) * L.qty;
    }
    return pnl;
  }

  private priceToTick(px: number) { return Math.round(px / CFG.execution.tickSize) * CFG.execution.tickSize; }

  async tick() {
    // 1) Data
    const candles = await this.m.fetchCandles(CFG.symbol, CFG.interval, Math.max(...CFG.maLens, CFG.atrLen) + 200);
    const closes = candles.map(c => c.c);
    const emaStack = CFG.maLens.map(L => ema(closes, L));
    const lastIdx = closes.length - 1;
    const lastEMAs = emaStack.map(a => a[lastIdx]);
    const atrArr = atr(candles.slice(-Math.max(...CFG.maLens, CFG.atrLen) - 2), CFG.atrLen);
    const lastATR = atrArr[atrArr.length - 1];

    const { bid, ask } = await this.m.bestBidAsk(CFG.symbol);
    const mid = (bid + ask) / 2;

    // 2) Trend signal via EMA stack
    const bull = lastEMAs[0] > lastEMAs[1] && lastEMAs[1] > lastEMAs[2] && lastEMAs[2] > lastEMAs[3] && lastEMAs[3] > lastEMAs[4];
    const bear = lastEMAs[0] < lastEMAs[1] && lastEMAs[1] < lastEMAs[2] && lastEMAs[2] < lastEMAs[3] && lastEMAs[3] < lastEMAs[4];

    // 3) Hedge budget from gamma (backspread)
    const g = await this.opt.portfolioGreeks(CFG.underlyingForGreeks);
    // delta capacity ≈ k * |Γ| * S * dS_max
    const dS = mid * (CFG.gammaCap.dSmaxPct / 100); // convert bps to price if you pass pct as whole; here dSmaxPct is in % not bps
    const deltaCapacityUsd = CFG.gammaCap.k * Math.abs(g.gamma) * dS * mid; // (Γ * dS) * S

    // current delta from scalps ~ sum(dir * qty * S). Here we use qty * S as USD proxy.
    let scalperDeltaUsd = 0;
    for (const L of this.legs) {
      const dir = L.side === "LONG" ? 1 : -1;
      scalperDeltaUsd += dir * L.qty * mid;
    }

    const capacityLeftUsd = Math.max(0, deltaCapacityUsd - Math.abs(scalperDeltaUsd));

    // 4) Place staggered ladder entries (maker) if signal and capacity allow
    const canAdd = this.legs.length < CFG.ladder.maxConcurrent && capacityLeftUsd > 0;

    if (canAdd && bull) {
      await this.placeLadder("LONG", mid, lastATR, capacityLeftUsd);
    } else if (canAdd && bear) {
      await this.placeLadder("SHORT", mid, lastATR, capacityLeftUsd);
    }

    // 5) Update trailing stops & exit if hit
    await this.updateTrailsAndExits(mid, lastATR);

    // 6) Risk controls
    const mtm = this.snapPnl(mid);
    this.dailyPnL = mtm; // in a real OMS, include realized + unrealized

    if (this.dailyPnL <= CFG.risk.dailyLossCapUsd) {
      await this.flattenAll("DAILY_LOSS_CAP");
      return;
    }

    // Optional: limit notional
    const notional = this.legs.reduce((s, L) => s + Math.abs(L.qty * mid), 0);
    if (notional > CFG.risk.maxNotionalUsd) {
      // stop adding; optionally trim smallest leg
    }
  }

  private async placeLadder(side: Side, mid: number, lastATR: number, capUsd: number) {
    const dir = side === "LONG" ? 1 : -1;
    // compute max legs allowed by capacity
    const qtyPerLegUsd = CFG.ladder.baseQty * mid;
    const legsByCap = Math.max(1, Math.floor(capUsd / qtyPerLegUsd));
    const legsToPlace = Math.min(CFG.ladder.legs, legsByCap, CFG.ladder.maxConcurrent - this.legs.length);

    for (let i = 0; i < legsToPlace; i++) {
      const offsetBps = CFG.ladder.stepBps * (i + 1);
      const px = this.priceToTick(mid + dir * CFG.execution.bps(offsetBps, mid));
      const qty = CFG.ladder.baseQty;
      const orderSide: Order["side"] = side === "LONG" ? "BUY" : "SELL";
      const { orderId } = await this.m.placeOrder({ symbol: CFG.symbol, side: orderSide, qty, limitPrice: px, postOnly: CFG.execution.postOnly, tif: CFG.execution.tif });

      const stopGap = Math.max(CFG.trailing.minTrailBps / 10000 * mid, CFG.trailing.atrMult * lastATR);
      const trail = side === "LONG" ? px - stopGap : px + stopGap;
      const leg: Leg = { id: orderId, side, entryPx: px, qty, openTs: this.m.now(), trailingStop: trail, lastPeak: px };
      this.legs.push(leg);
    }
  }

  private async updateTrailsAndExits(mid: number, lastATR: number) {
    const toClose: Leg[] = [];
    for (const L of this.legs) {
      if (L.side === "LONG") {
        // update peak and trail
        if (mid > L.lastPeak) {
          L.lastPeak = mid;
          const gap = Math.max(CFG.trailing.minTrailBps / 10000 * mid, CFG.trailing.atrMult * lastATR);
          L.trailingStop = Math.max(L.trailingStop, this.priceToTick(L.lastPeak - gap));
        }
        // stop hit
        if (mid <= L.trailingStop) toClose.push(L);
      } else {
        // SHORT
        if (mid < L.lastPeak) {
          L.lastPeak = mid;
          const gap = Math.max(CFG.trailing.minTrailBps / 10000 * mid, CFG.trailing.atrMult * lastATR);
          L.trailingStop = Math.min(L.trailingStop, this.priceToTick(L.lastPeak + gap));
        }
        if (mid >= L.trailingStop) toClose.push(L);
      }
    }

    for (const L of toClose) {
      await this.closeLeg(L, mid, "TRAIL_HIT");
    }

    // clean array
    this.legs = this.legs.filter(L => !toClose.includes(L));
  }

  private async closeLeg(L: Leg, px: number, reason: string) {
    const side: Order["side"] = L.side === "LONG" ? "SELL" : "BUY";
    const { orderId } = await this.m.placeOrder({ symbol: CFG.symbol, side, qty: L.qty, limitPrice: px, postOnly: CFG.execution.postOnly, tif: CFG.execution.tif });
    // In production, wait for fill & compute realized PnL; here we assume instant maker fill for brevity
    // console.log(`Closed ${L.id} -> ${orderId} reason=${reason}`)
  }

  private async flattenAll(reason: string) {
    const { bid, ask } = await this.m.bestBidAsk(CFG.symbol);
    const px = (bid + ask) / 2;
    for (const L of this.legs) {
      await this.closeLeg(L, px, reason);
    }
    this.legs = [];
  }
}

/************************** Minimal Mock Adapters **************************/

// These stubs are here so the file compiles; replace with your venue SDKs.
class MockMarket implements MarketAdapter {
  private _pos: Position | null = null;
  now() { return Date.now(); }
  async fetchCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    // Supply your own data feed; here we synthesize flat prices ~ for structure
    const now = Date.now();
    const out: Candle[] = [];
    let px = 50000;
    for (let i = limit - 1; i >= 0; i--) {
      const ts = now - i * 5 * 60 * 1000;
      const drift = (Math.sin(i / 10) * 5);
      const o = px;
      const c = px + drift;
      const h = Math.max(o, c) + 10;
      const l = Math.min(o, c) - 10;
      px = c;
      out.push({ ts, o, h, l, c });
    }
    return out;
  }
  async bestBidAsk(symbol: string) { return { bid: 50000 - 1, ask: 50000 + 1 }; }
  async placeOrder(o: Order) { return { orderId: Math.random().toString(36).slice(2) }; }
  async cancelOrder(orderId: string) { }
  async openOrders(symbol: string) { return []; }
  async position(symbol: string) { return this._pos; }
}

class MockOptions implements OptionsAdapter {
  async portfolioGreeks(underlying: string): Promise<Greeks> {
    // Pretend we hold long gamma via backspreads
    return { delta: 0, gamma: 2e-6, theta: -50 }; // Gamma units approx 1/$
  }
}

/************************** Boot **************************/

async function main() {
  const m = new MockMarket();
  const o = new MockOptions();
  const s = new Scalper(m, o);

  // crude scheduler; in prod, sync to candle close/open
  setInterval(() => s.tick().catch(console.error), 5_000);
  console.log(`[${dayjs().format()}] Gamma-Hedged MA Scalper started for ${CFG.symbol}`);
}

if (require.main === module) {
  // @ts-ignore
  main().catch(err => { console.error(err); process.exit(1); });
}


/************************** Binance Perps Adapter **************************/
// src/adapters/binance.ts
// USDC-M futures (perps). Uses REST for simplicity; add WS user stream for fills in prod.
import axios from "axios";
import crypto from "crypto";

export class BinancePerps implements MarketAdapter {
  private http = axios.create({ baseURL: "https://dapi.binance.com", timeout: 10000 }); // USDT-M would be fapi; USDC-M is dapi for coin-margined; adjust if needed
  constructor(private apiKey: string, private apiSecret: string) {}

  now() { return Date.now(); }

  private sign(params: Record<string, any>) {
    const qs = new URLSearchParams(params as any).toString();
    const sig = crypto.createHmac("sha256", this.apiSecret).update(qs).digest("hex");
    return { qs: qs + "&signature=" + sig };
  }

  async fetchCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const r = await this.http.get("/dapi/v1/continuousKlines", { params: { pair: symbol.replace("-PERP",""), contractType: "PERPETUAL", interval: interval.replace("m","m"), limit } });
    return r.data.map((k: any) => ({ ts: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  }

  async bestBidAsk(symbol: string) {
    const r = await this.http.get("/dapi/v1/ticker/bookTicker", { params: { symbol: symbol.replace("-PERP","") + "_PERP" } });
    return { bid: +r.data.bidPrice, ask: +r.data.askPrice };
  }

  async placeOrder(o: Order) {
    const side = o.side;
    const type = "LIMIT";
    const timeInForce = o.tif ?? "GTC";
    const params: any = {
      symbol: o.symbol.replace("-PERP","") + "_PERP",
      side,
      type,
      quantity: o.qty,
      price: o.limitPrice,
      timeInForce,
      recvWindow: 5000,
      timestamp: this.now()
    };
    if (o.postOnly) params.timeInForce = "GTX"; // Binance post-only via GTX
    const { qs } = this.sign(params);
    const r = await this.http.post("/dapi/v1/order?" + qs, null, { headers: { "X-MBX-APIKEY": this.apiKey } });
    return { orderId: String(r.data.orderId) };
  }

  async cancelOrder(orderId: string) {
    // Not used in this minimal flow; implement as needed
  }

  async openOrders(symbol: string) { return []; }
  async position(symbol: string): Promise<Position | null> { return null; }
}

/************************** Alpaca Options Greeks Adapter **************************/
// src/adapters/alpacaOptions.ts
// Pulls option chain greeks and aggregates net portfolio greeks for the underlying.
import axios from "axios";

export class AlpacaOptionsGreeks implements OptionsAdapter {
  private data = axios.create({ baseURL: process.env.ALPACA_DATA_URL || "https://data.alpaca.markets", timeout: 10000, headers: { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID || "", "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY || "" } });
  private acct = axios.create({ baseURL: process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets", timeout: 10000, headers: { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID || "", "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY || "" } });

  async portfolioGreeks(underlying: string): Promise<Greeks> {
    // Fetch open positions; sum greeks per option using snapshot greeks
    const pos = await this.acct.get("/v2/positions");
    const options = pos.data.filter((p: any) => p.asset_class === "option");
    if (!options.length) return { delta: 0, gamma: 0, theta: 0, vega: 0 };

    let agg = { delta: 0, gamma: 0, theta: 0, vega: 0 };
    for (const p of options) {
      // Expect symbol like IBIT250926C120; fetch snapshot which includes greeks
      try {
        const snap = await this.data.get(`/v1beta1/options/snapshots/${p.symbol}`);
        const g = snap.data?.greeks;
        if (!g) continue;
        const qty = Number(p.qty);
        agg.delta += (g.delta || 0) * qty * 100; // 100 multiplier for equity options
        agg.gamma += (g.gamma || 0) * qty * 100;
        agg.theta += (g.theta || 0) * qty * 100;
        agg.vega  += (g.vega  || 0) * qty * 100;
      } catch {}
    }
    return agg;
  }
}

/************************** Wiring: use Binance for perps, Alpaca for options **************************/
// In main(), replace Mock adapters with live ones.
// const m = new BinancePerps(process.env.BINANCE_KEY!, process.env.BINANCE_SECRET!);
// const o = new AlpacaOptionsGreeks();
// const s = new Scalper(m, o);
// setInterval(() => s.tick().catch(console.error), 5_000);

/************************** .env additions **************************/
// BINANCE_KEY=...
// BINANCE_SECRET=...
// UNDERLYING=BTC-PERP           # for Binance symbol mapping
// UNDERLYING_BASE=BTC           # for options greeks aggregation
// ALPACA_KEY_ID=...
// ALPACA_SECRET_KEY=...
// ALPACA_BASE_URL=https://paper-api.alpaca.markets
// ALPACA_DATA_URL=https://data.alpaca.markets
