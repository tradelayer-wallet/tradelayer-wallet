import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild
} from '@angular/core';
import {
  ChartOptions,
  createChart,
  DeepPartial,
  IChartApi,
  ISeriesApi
} from 'lightweight-charts';

import { SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';
import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';


export interface ICandle {
  time: any;
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
}

export const chartOptions: DeepPartial<ChartOptions> = {
  layout: {
    backgroundColor: '#1B1E34',
    textColor: 'white',
  },
  grid: {
    vertLines: { color: 'rgba(255, 255, 255, 0.2)' },
    horzLines: { color: 'rgba(255, 255, 255, 0.2)' },
  },
  crosshair: { mode: 0 },
  timeScale: {
    timeVisible: true,
    secondsVisible: true,
    rightBarStaysOnScroll: true,
    borderVisible: false,
  },
};

@Component({
  selector: 'tl-spot-chart-card',
  templateUrl: './spot-chart-card.component.html',
  styleUrls: ['./spot-chart-card.component.scss'],
})
export class SpotChartCardComponent
  implements AfterViewInit, OnDestroy
{
  @ViewChild('chart', { static: true }) chartElement!: ElementRef;

  private chart?: IChartApi;
  private candleStickSeries?: ISeriesApi<'Candlestick'>;

  private bars: ICandle[] = [];
  private lastBar: ICandle | null = null;

  private candleIntervalSec = 1;
  private maxBars = 600;
  get timeframeSec(): number {
    return this.candleIntervalSec;
  }


  private quotePoll: any = null;
  private pollMs = 150;

  constructor(private spotOrderbookService: SpotOrderbookService,
    private spotMarketsService: SpotMarketsService) {}

  ngAfterViewInit(): void {
    setTimeout(async () => {
      this.createChart();
      this.forceResize();
      await this.loadSpotHistory();
      this.startQuotePolling();
    }, 0);
  }

  ngOnDestroy(): void {
    if (this.quotePoll) {
      clearInterval(this.quotePoll);
      this.quotePoll = null;
    }
    this.destroyChart();
  }

  @HostListener('window:resize')
  onResize() {
    this.forceResize();
  }

  get chartContainer(): HTMLElement {
    return this.chartElement.nativeElement;
  }

  private forceResize() {
    if (!this.chart) return;

    const w = this.chartContainer.offsetWidth;
    const h = this.chartContainer.offsetHeight;

    if (w > 0 && h > 0) {
      this.chart.resize(w, h, true);
      this.chart.timeScale().fitContent();
    }
  }

  private normalizeSymbolForCoinbase(symbol: string): string | null {
  if (!symbol) return null;

  // 1) Trim testnet prefix
  if (symbol.startsWith('t')) {
    symbol = symbol.slice(1);
  }

  // 2) Futures perps → underlying spot
  // BTC/USDT, BTC-PERP, etc → BTC-USD
  symbol = symbol
    .replace('/USDT', '-USD')
    .replace('/USD', '-USD')
    .replace('USDT', 'USD')
    .replace('_PERP', '')
    .replace('-PERP', '');

  // Coinbase expects DASH
  symbol = symbol.replace('/', '-');

  return symbol;
}

private async loadSpotHistory() {
  const rawSymbol = this.spotMarketsService?.selectedMarket?.pairString


  const cbSymbol = this.normalizeSymbolForCoinbase(rawSymbol);
  if (!cbSymbol) return;

  await this.loadHistory(cbSymbol, 60);
}



  private createChart() {
    this.destroyChart();
    this.chart = createChart(this.chartContainer, chartOptions);
    this.candleStickSeries = this.chart.addCandlestickSeries();
    this.candleStickSeries.setData([]);
  }

  private destroyChart() {
    if (this.chart) {
      try {
        this.chart.remove();
      } catch {}
      this.chart = undefined;
      this.candleStickSeries = undefined;
    }
  }

  private startQuotePolling() {
    if (this.quotePoll) return;

    this.quotePoll = setInterval(() => {
      const { bid, ask } = this.getBestBidAsk(this.spotOrderbookService as any);
      const mid =
        bid !== undefined && ask !== undefined
          ? (bid + ask) / 2
          : bid ?? ask ?? null;

      if (mid == null) return;
      this.upsertBarFromMid(mid, Date.now());
    }, this.pollMs);
  }

  setTimeframe(sec: number) {
    const next = Number(sec);
    if (!Number.isFinite(next) || next <= 0) return;

    // No-op if unchanged
    if (this.candleIntervalSec === next) return;

    this.candleIntervalSec = next;

    // Reset candle state cleanly
    this.bars = [];
    this.lastBar = null;

    this.candleStickSeries?.setData([]);

    // Optional: refit view
    this.chart?.timeScale().fitContent();
  }


  private upsertBarFromMid(mid: number, tsMs: number) {
    const tSec = Math.floor(tsMs / 1000);
    const bucket = Math.floor(tSec / this.candleIntervalSec) * this.candleIntervalSec;

    if (!this.lastBar || this.lastBar.time !== bucket) {
      const bar: ICandle = {
        time: bucket,
        open: mid,
        high: mid,
        low: mid,
        close: mid,
        volume: 0,
      };

      this.lastBar = bar;
      this.bars.push(bar);
      if (this.bars.length > this.maxBars) this.bars.shift();

      this.candleStickSeries?.setData(this.bars as any);
      return;
    }

    this.lastBar.high = Math.max(this.lastBar.high, mid);
    this.lastBar.low = Math.min(this.lastBar.low, mid);
    this.lastBar.close = mid;

    this.candleStickSeries?.update(this.lastBar as any);
    this.chart?.timeScale().scrollToRealTime();
  }

  private getBestBidAsk(svc: any): { bid?: number; ask?: number } {
    if (Array.isArray(svc?.bids) || Array.isArray(svc?.asks)) {
      return {
        bid: this.extractTopPrice(svc.bids, 'bid'),
        ask: this.extractTopPrice(svc.asks, 'ask'),
      };
    }

    if (svc?.orderbook) {
      return {
        bid: this.extractTopPrice(svc.orderbook.bids, 'bid'),
        ask: this.extractTopPrice(svc.orderbook.asks, 'ask'),
      };
    }

    if (Array.isArray(svc?.rawOrderbookData)) {
      let bid: number | undefined;
      let ask: number | undefined;

      for (const r of svc.rawOrderbookData) {
        const px = Number(r?.price ?? r?.rate ?? r?.p);
        if (!Number.isFinite(px)) continue;

        const isAsk = !!(r?.sell ?? r?.side === 'sell');
        if (isAsk) ask = ask == null ? px : Math.min(ask, px);
        else bid = bid == null ? px : Math.max(bid, px);
      }
      return { bid, ask };
    }

    return {};
  }

  private secsToGranularity(secs: number): string {
    const map: Record<number, string> = {
      5: 'ONE_MINUTE',      // sub-minute falls back to 1m data
      60: 'ONE_MINUTE',
      300: 'FIVE_MINUTE',
      900: 'FIFTEEN_MINUTE',
      1800: 'THIRTY_MINUTE',
      3600: 'ONE_HOUR',
      7200: 'TWO_HOUR',
      21600: 'SIX_HOUR',
      86400: 'ONE_DAY',
    };
    return map[secs] || 'ONE_MINUTE';
  }

  private async loadHistory(symbol: string, intervalSec: number) {
    if (!this.candleStickSeries) return;

    try {
      const cbSymbol = this.normalizeSymbolForCoinbase(symbol);

      const now = Math.floor(Date.now() / 1000);
      const lookbackBars = this.maxBars;
      const start = now - lookbackBars * intervalSec;

      const granularity = this.secsToGranularity(intervalSec);
      const url =
        `https://api.coinbase.com/api/v3/brokerage/market/products/${cbSymbol}/candles` +
        `?start=${start}&end=${now}&granularity=${granularity}`;

      const res = await fetch(url);
      if (!res.ok) return;

      const data = await res.json();
      const raw = data?.candles;
      if (!Array.isArray(raw)) return;

      const candles: ICandle[] = raw
        .map((c: any) => ({
          time: Number(c.start),
          low: Number(c.low),
          high: Number(c.high),
          open: Number(c.open),
          close: Number(c.close),
          volume: Number(c.volume ?? 0),
        }))
        .sort((a, b) => a.time - b.time)
        .slice(-this.maxBars);

      if (!candles.length) return;

      this.bars = candles;
      this.lastBar = candles[candles.length - 1];

      this.candleStickSeries.setData(this.bars as any);

      this.chart?.timeScale().fitContent();
    } catch (err) {
      console.warn('History load failed:', err);
    }
  }


  private extractTopPrice(arr: any[], side: 'bid' | 'ask'): number | undefined {
    if (!Array.isArray(arr) || !arr.length) return undefined;

    let best: number | undefined;
    for (const it of arr) {
      const px = Array.isArray(it) ? Number(it[0]) : Number(it?.price ?? it?.p);
      if (!Number.isFinite(px)) continue;
      best = best == null ? px : side === 'bid' ? Math.max(best, px) : Math.min(best, px);
    }
    return best;
  }
}
