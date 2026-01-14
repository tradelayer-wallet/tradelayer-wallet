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

import { FuturesOrderbookService } from 'src/app/@core/services/futures-services/futures-orderbook.service';

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
    rightOffset: 50,
    tickMarkFormatter: (t: any) => {
      const date = new Date(Number(`${t}000`)).toString().split(' ');
      return `${date[1]} ${date[2]} ${date[4]}`;
    },
  },
};

@Component({
  selector: 'tl-futures-chart-card',
  templateUrl:
    '../../../spot-page/spot-trading-grid/spot-chart-card/spot-chart-card.component.html',
  styleUrls: [
    '../../../spot-page/spot-trading-grid/spot-chart-card/spot-chart-card.component.scss',
  ],
})
export class FuturesChartCardComponent
  implements AfterViewInit, OnDestroy
{
  @ViewChild('chart', { static: true }) chartElement!: ElementRef;

  private chart?: IChartApi;
  private candleStickSeries?: ISeriesApi<'Candlestick'>;

  private bars: ICandle[] = [];
  private lastBar: ICandle | null = null;

  private candleIntervalSec = 1;
  private maxBars = 600;

  private quotePoll: any = null;
  private pollMs = 250;

  constructor(private futuresOrderbookService: FuturesOrderbookService) {}

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------
  ngAfterViewInit(): void {
    // allow mat-card / tabs / layout to settle
    setTimeout(() => {
      this.createChart();
      this.forceResize();
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

  // ---------------------------------------------------------------------------
  // resize handling
  // ---------------------------------------------------------------------------
  @HostListener('window:resize')
  onResize() {
    this.forceResize();
  }

  private forceResize() {
    if (!this.chart || !this.chartContainer) return;

    const w = this.chartContainer.offsetWidth;
    const h = this.chartContainer.offsetHeight;

    if (w > 0 && h > 0) {
      this.chart.resize(w, h, true);
      this.chart.timeScale().fitContent();
    }
  }

  get chartContainer(): HTMLElement {
    return this.chartElement.nativeElement;
  }

  // ---------------------------------------------------------------------------
  // chart init / destroy
  // ---------------------------------------------------------------------------
  private createChart() {
    this.destroyChart();

    if (!this.chartContainer) return;

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

  // ---------------------------------------------------------------------------
  // polling + candles
  // ---------------------------------------------------------------------------
  private startQuotePolling() {
    if (this.quotePoll) return;

    this.quotePoll = setInterval(() => {
      const { bid, ask } = this.getBestBidAsk(
        this.futuresOrderbookService as any
      );

      const mid =
        bid !== undefined && ask !== undefined
          ? (bid + ask) / 2
          : bid ?? ask ?? null;

      if (mid == null) return;

      this.upsertBarFromMid(mid, Date.now());
    }, this.pollMs);
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
  }

  // ---------------------------------------------------------------------------
  // orderbook helpers (unchanged logic)
  // ---------------------------------------------------------------------------
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
