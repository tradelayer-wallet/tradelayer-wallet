import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, Renderer2, ViewChild } from '@angular/core';
import { ChartOptions, createChart, DeepPartial, IChartApi, ISeriesApi } from 'lightweight-charts';

// Futures orderbook service (used to source best bid/ask quotes)
import { FuturesOrderbookService } from 'src/app/@core/services/futures-services/futures-orderbook.service';

export interface ICandle {
  time: any;
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
};

export const chartOptions: DeepPartial<ChartOptions> = {
  layout: {
      backgroundColor: "#1B1E34",
      textColor: "white",
  },
  grid: {
      vertLines: {
          color: "rgba(255, 255, 255, 0.2)"
      },
      horzLines: {
          color: "rgba(255, 255, 255, 0.2)"
      }
  },
  crosshair: {
      mode: 0,
  },
  timeScale: {
      rightOffset: 50,
      tickMarkFormatter: (t: any) => {
          const date = new Date(parseFloat(`${t}000`)).toString();
          const arr = date.split(" ");
          const month = arr[1];
          const day = arr[2];
          const time = arr[4];
          return `${month} ${day} ${time}`;
      },
  },
};

@Component({
  selector: 'tl-futures-chart-card',
  templateUrl: '../../../spot-page/spot-trading-grid/spot-chart-card/spot-chart-card.component.html',
  styleUrls: ['../../../spot-page/spot-trading-grid/spot-chart-card/spot-chart-card.component.scss']
})
export class FuturesChartCardComponent implements AfterViewInit, OnDestroy {
  @ViewChild('chart') chartElement: ElementRef | undefined;

  private chart: IChartApi | undefined;
  private candleStickseries: ISeriesApi<'Candlestick'> | undefined;

  private bars: ICandle[] = [];
  private lastBar: ICandle | null = null;

  private candleIntervalSec: number = 1;
  private maxBars: number = 600;

  private quotePoll: any = null;
  private pollMs: number = 250;

  constructor(
    private renderer2: Renderer2,
    private futuresOrderbookService: FuturesOrderbookService
  ) {}

  @HostListener('window:resize', ['$event'])
  private onResize = (_event: any) => {
    const { offsetWidth, offsetHeight } = this.chartContainer;
    if (this.chart) this.chart.resize(offsetWidth, offsetHeight, true);
  };

  get chartContainer() {
    return this.chartElement?.nativeElement;
  }

  ngAfterViewInit(): void {
    this.createChart();
    this.startQuotePolling();
  }

  ngOnDestroy(): void {
    if (this.quotePoll) {
      clearInterval(this.quotePoll);
      this.quotePoll = null;
    }
    if (this.chart) {
      this.chart.remove();
      this.chart = undefined;
    }
  }

  private createChart() {
    this.chart = createChart(this.chartContainer, chartOptions);
    this.candleStickseries = this.chart.addCandlestickSeries();
    this.candleStickseries.setData([]);
  }

  private startQuotePolling() {
    if (this.quotePoll) return;
    this.quotePoll = setInterval(() => {
      const { bid, ask } = this.getBestBidAsk(this.futuresOrderbookService as any);

      const mid = (bid !== undefined && ask !== undefined)
        ? (bid + ask) / 2
        : (bid !== undefined ? bid : (ask !== undefined ? ask : null));

      if (mid === null) return;

      this.upsertBarFromMid(mid, Date.now());
    }, this.pollMs);
  }

  private getBestBidAsk(svc: any): { bid?: number; ask?: number } {
    if (Array.isArray(svc?.bids) || Array.isArray(svc?.asks)) {
      const bid = this.extractTopPrice(svc?.bids, 'bid');
      const ask = this.extractTopPrice(svc?.asks, 'ask');
      return { bid, ask };
    }

    if (svc?.orderbook && (Array.isArray(svc.orderbook.bids) || Array.isArray(svc.orderbook.asks))) {
      const bid = this.extractTopPrice(svc.orderbook.bids, 'bid');
      const ask = this.extractTopPrice(svc.orderbook.asks, 'ask');
      return { bid, ask };
    }

    if (Array.isArray(svc?.rawOrderbookData)) {
      let bestBid: number | undefined = undefined;
      let bestAsk: number | undefined = undefined;

      for (const r of svc.rawOrderbookData) {
        const px = Number(r?.price ?? r?.rate ?? r?.p);
        if (!Number.isFinite(px)) continue;

        const isAsk = !!(r?.sell ?? r?.isAsk ?? (r?.side === 'sell'));
        if (isAsk) {
          if (bestAsk === undefined || px < bestAsk) bestAsk = px;
        } else {
          if (bestBid === undefined || px > bestBid) bestBid = px;
        }
      }
      return { bid: bestBid, ask: bestAsk };
    }

    return {};
  }

  private extractTopPrice(arr: any, side: 'bid' | 'ask'): number | undefined {
    if (!Array.isArray(arr) || arr.length === 0) return undefined;

    let best: number | undefined = undefined;

    for (const it of arr) {
      const px = Array.isArray(it) ? Number(it[0]) : Number(it?.price ?? it?.rate ?? it?.p);
      if (!Number.isFinite(px)) continue;

      if (best === undefined) {
        best = px;
      } else {
        best = side === 'bid' ? Math.max(best, px) : Math.min(best, px);
      }
    }

    return best;
  }

  private upsertBarFromMid(mid: number, tsMs: number) {
    const tSec = Math.floor(tsMs / 1000);
    const interval = Math.max(1, Math.floor(this.candleIntervalSec));
    const bucketSec = Math.floor(tSec / interval) * interval;

    if (!this.lastBar || this.lastBar.time !== bucketSec) {
      const bar: ICandle = {
        time: bucketSec,
        open: mid,
        high: mid,
        low: mid,
        close: mid,
        volume: 0,
      };

      this.lastBar = bar;
      this.bars.push(bar);

      if (this.bars.length > this.maxBars) {
        this.bars.shift();
      }

      this.candleStickseries?.setData(this.bars as any);
      return;
    }

    this.lastBar.high = Math.max(this.lastBar.high, mid);
    this.lastBar.low = Math.min(this.lastBar.low, mid);
    this.lastBar.close = mid;

    this.candleStickseries?.update(this.lastBar as any);
  }
}
