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
import {
  createTradingViewWidget,
  loadTradingViewScript,
  resolveTradingViewSymbol,
  tradingViewInterval,
} from 'src/app/@core/utils/tradingview-chart.util';

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
export class SpotChartCardComponent implements AfterViewInit, OnDestroy {
  @ViewChild('chart', { static: true }) chartElement!: ElementRef;

  chartMode: 'advanced' | 'fallback' = 'advanced';
  chartStatus = 'TradingView Advanced';
  advancedSymbol = '';

  private chart?: IChartApi;
  private candleStickSeries?: ISeriesApi<'Candlestick'>;
  private tradingViewWidget: any = null;

  private bars: ICandle[] = [];
  private lastBar: ICandle | null = null;
  private candleIntervalSec = 60;
  private maxBars = 600;
  private quotePoll: any = null;
  private pollMs = 1500;
  private marketWatchPoll: any = null;
  private activeMarketKey = '';
  private chartObserver: IntersectionObserver | null = null;
  private chartBootstrapped = false;
  private chartBootTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private spotOrderbookService: SpotOrderbookService,
    private spotMarketsService: SpotMarketsService
  ) {}

  get timeframeSec(): number {
    return this.candleIntervalSec;
  }

  get chartContainer(): HTMLElement {
    return this.chartElement.nativeElement;
  }

  ngAfterViewInit(): void {
    this.deferChartBootstrap();
  }

  ngOnDestroy(): void {
    this.stopChartBootstrap();
    this.stopMarketWatcher();
    this.stopQuotePolling();
    this.destroyChart();
    this.destroyAdvancedChart();
  }

  @HostListener('window:resize')
  onResize() {
    this.forceResize();
  }

  setTimeframe(sec: number) {
    const next = Number(sec);
    if (!Number.isFinite(next) || next <= 0 || this.candleIntervalSec === next) return;
    this.candleIntervalSec = next;
    this.renderPreferredChart();
  }

  reloadAdvancedChart() {
    this.renderPreferredChart();
  }

  private deferChartBootstrap() {
    if (this.chartBootstrapped) return;

    const boot = () => {
      if (this.chartBootstrapped) return;
      this.chartBootstrapped = true;
      this.renderPreferredChart();
      this.startMarketWatcher();
    };

    const host = this.chartElement?.nativeElement;
    if (host && typeof IntersectionObserver !== 'undefined') {
      this.chartObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          this.stopChartBootstrap();
          boot();
        }
      }, { threshold: 0.15 });
      this.chartObserver.observe(host);
      return;
    }

    this.chartBootTimer = setTimeout(() => boot(), 1000);
  }

  private stopChartBootstrap() {
    if (this.chartObserver) {
      this.chartObserver.disconnect();
      this.chartObserver = null;
    }
    if (this.chartBootTimer) {
      clearTimeout(this.chartBootTimer);
      this.chartBootTimer = null;
    }
  }

  private async renderPreferredChart() {
    this.stopQuotePolling();
    this.destroyChart();
    this.destroyAdvancedChart();

    const rawSymbol = this.getMarketKey();
    this.activeMarketKey = rawSymbol;
    const tvSymbol = resolveTradingViewSymbol(rawSymbol);
    if (tvSymbol) {
      try {
        this.chartMode = 'advanced';
        this.chartStatus = 'TradingView Advanced';
        this.advancedSymbol = tvSymbol;
        await loadTradingViewScript();
        this.tradingViewWidget = createTradingViewWidget(
          this.chartContainer,
          tvSymbol,
          tradingViewInterval(this.candleIntervalSec)
        );
        return;
      } catch (err) {
        console.warn('TradingView Advanced chart failed; using lightweight fallback:', err);
      }
    }

    await this.startFallbackChart(tvSymbol ? 'Advanced unavailable' : 'Unsupported public symbol');
  }

  private async startFallbackChart(reason: string) {
    this.chartMode = 'fallback';
    this.chartStatus = `Fallback: ${reason}`;
    this.advancedSymbol = '';
    this.createChart();
    this.forceResize();
    await this.loadSpotHistory();
    this.startQuotePolling();
  }

  private createChart() {
    this.destroyChart();
    this.chartContainer.innerHTML = '';
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

  private destroyAdvancedChart() {
    this.tradingViewWidget = null;
    if (this.chartElement?.nativeElement) {
      this.chartElement.nativeElement.innerHTML = '';
    }
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

  private async loadSpotHistory() {
    const cbSymbol = this.normalizeSymbolForCoinbase(this.getMarketKey());
    if (!cbSymbol) return;
    await this.loadHistory(cbSymbol, this.candleIntervalSec);
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

  private stopQuotePolling() {
    if (!this.quotePoll) return;
    clearInterval(this.quotePoll);
    this.quotePoll = null;
  }

  private startMarketWatcher() {
    if (this.marketWatchPoll) return;
    this.marketWatchPoll = setInterval(() => {
      const nextMarketKey = this.getMarketKey();
      if (nextMarketKey && nextMarketKey !== this.activeMarketKey) {
        this.renderPreferredChart();
      }
    }, 5000);
  }

  private stopMarketWatcher() {
    if (!this.marketWatchPoll) return;
    clearInterval(this.marketWatchPoll);
    this.marketWatchPoll = null;
  }

  private getMarketKey(): string {
    return this.spotMarketsService?.selectedMarket?.pairString || '';
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

        const isAsk = !!(r?.sell ?? r?.isAsk ?? r?.side === 'sell');
        if (isAsk) ask = ask == null ? px : Math.min(ask, px);
        else bid = bid == null ? px : Math.max(bid, px);
      }
      return { bid, ask };
    }

    return {};
  }

  private secsToGranularity(secs: number): string {
    const map: Record<number, string> = {
      5: 'ONE_MINUTE',
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

  private normalizeSymbolForCoinbase(symbol?: string | null): string | null {
    if (!symbol) return null;
    let value = symbol.toUpperCase();
    if (value.startsWith('T') && ['TBTC', 'TLTC', 'TETH', 'TDOGE'].some(prefix => value.startsWith(prefix))) {
      value = value.slice(1);
    }
    value = value
      .replace('/USDT', '-USD')
      .replace('/USD', '-USD')
      .replace('USDT', 'USD')
      .replace('_PERP', '')
      .replace('-PERP', '')
      .replace('/', '-');
    return value;
  }

  private async loadHistory(symbol: string, intervalSec: number) {
    if (!this.candleStickSeries) return;

    try {
      const now = Math.floor(Date.now() / 1000);
      const start = now - this.maxBars * intervalSec;
      const granularity = this.secsToGranularity(intervalSec);
      const url =
        `https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}/candles` +
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
      console.warn('Fallback history load failed:', err);
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
