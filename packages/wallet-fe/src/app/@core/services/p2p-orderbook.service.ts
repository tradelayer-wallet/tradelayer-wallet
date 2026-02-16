import { Injectable, NgZone } from '@angular/core';
import { Subscription } from 'rxjs';
import type { TapeEntryV1 } from 'src/p2p/types';
import { P2PSettingsService } from './p2p-settings.service';
import { P2PTransportService } from './p2p-transport.service';

type Side = 'BUY' | 'SELL';

type PriceKey = number; // px * 1e4 truncated
const PRICE_SCALE = 10000;

function toPriceKey(px: string): PriceKey {
  const n = Number(px);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n * PRICE_SCALE);
}

function fromPriceKey(k: PriceKey): number {
  return k / PRICE_SCALE;
}

function scopeMarket(scope: 'SPOT' | 'FUTURES', pairString: string): string {
  const p = String(pairString || '').trim();
  return `${scope === 'FUTURES' ? 'FUT' : 'SPOT'}:${p}`;
}

@Injectable({ providedIn: 'root' })
export class P2POrderbookService {
  private sub: Subscription | null = null;

  // orderId -> record
  private orders = new Map<string, { market: string; side: Side; pxKey: PriceKey; qty: number }>();

  // market -> side -> pxKey -> totalQty
  private levels = new Map<string, { BUY: Map<PriceKey, number>; SELL: Map<PriceKey, number> }>();

  constructor(
    private p2p: P2PTransportService,
    private settings: P2PSettingsService,
    private zone: NgZone
  ) {
    this.sub = this.p2p.tape$.subscribe((e) => {
      if (!e) return;
      if (this.settings.mode === 'CENTRAL') return;
      this.zone.run(() => this.onEntry(e));
    });
  }

  private getLevelMaps(market: string) {
    let m = this.levels.get(market);
    if (!m) {
      m = { BUY: new Map(), SELL: new Map() };
      this.levels.set(market, m);
    }
    return m;
  }

  private addToLevel(market: string, side: Side, pxKey: PriceKey, qty: number) {
    const lm = this.getLevelMaps(market)[side];
    const next = (lm.get(pxKey) || 0) + qty;
    if (next <= 0) lm.delete(pxKey);
    else lm.set(pxKey, next);
  }

  private removeOrder(orderId: string) {
    const rec = this.orders.get(orderId);
    if (!rec) return;
    this.orders.delete(orderId);
    this.addToLevel(rec.market, rec.side, rec.pxKey, -rec.qty);
  }

  private onEntry(e: TapeEntryV1) {
    const env: any = e.order;
    if (!env || typeof env.kind !== 'string' || typeof env.orderId !== 'string') return;

    if (env.kind === 'NEW') {
      const body: any = env.body || {};
      const market = String(body.market || '');
      const side: Side = body.side === 'SELL' ? 'SELL' : 'BUY';
      const pxKey = toPriceKey(String(body.px || '0'));
      const qty = Number(body.qty);
      if (!market || !Number.isFinite(qty) || qty <= 0) return;
      if (this.orders.has(env.orderId)) return; // dedupe
      this.orders.set(env.orderId, { market, side, pxKey, qty });
      this.addToLevel(market, side, pxKey, qty);
      return;
    }

    if (env.kind === 'CANCEL') {
      const target = String(env.cancelsOrderId || '').trim();
      if (!target) return;
      this.removeOrder(target);
      return;
    }

    if (env.kind === 'REPLACE') {
      const target = String(env.replacesOrderId || '').trim();
      if (target) this.removeOrder(target);
      // Then treat the replace itself as a NEW orderId (body carries new px/qty).
      const body: any = env.body || {};
      const market = String(body.market || '');
      const side: Side = body.side === 'SELL' ? 'SELL' : 'BUY';
      const pxKey = toPriceKey(String(body.px || '0'));
      const qty = Number(body.qty);
      if (!market || !Number.isFinite(qty) || qty <= 0) return;
      if (this.orders.has(env.orderId)) return;
      this.orders.set(env.orderId, { market, side, pxKey, qty });
      this.addToLevel(market, side, pxKey, qty);
      return;
    }
  }

  getLevels(scope: 'SPOT' | 'FUTURES', pairString: string): { buy: Array<{ price: number; amount: number }>; sell: Array<{ price: number; amount: number }> } {
    const mk = scopeMarket(scope, pairString);
    const m = this.levels.get(mk);
    if (!m) return { buy: [], sell: [] };

    const buy: Array<{ price: number; amount: number }> = [];
    const sell: Array<{ price: number; amount: number }> = [];

    for (const [k, v] of m.BUY.entries()) buy.push({ price: fromPriceKey(k), amount: v });
    for (const [k, v] of m.SELL.entries()) sell.push({ price: fromPriceKey(k), amount: v });

    buy.sort((a, b) => b.price - a.price);
    sell.sort((a, b) => b.price - a.price);

    return { buy: buy.slice(0, 9), sell: sell.slice(Math.max(sell.length - 9, 0)) };
  }

  // Market price proxy for UI: mid price of best bid/ask if both exist, else best side.
  getMarketPrice(scope: 'SPOT' | 'FUTURES', pairString: string): number {
    const { buy, sell } = this.getLevels(scope, pairString);
    const bestBid = buy.length ? buy[0].price : null;
    const bestAsk = sell.length ? sell[sell.length - 1].price : null;
    if (bestBid != null && bestAsk != null) return (bestBid + bestAsk) / 2;
    if (bestBid != null) return bestBid;
    if (bestAsk != null) return bestAsk;
    return 0;
  }
}

