import { AfterViewInit, Component, ElementRef, HostListener, OnInit, Renderer2, ViewChild } from '@angular/core';
import { ChartOptions, createChart, DeepPartial, IChartApi, ISeriesApi } from 'lightweight-charts';

export interface ICandle {
  time: string;
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
};

const getRandomData = (len = 20) => {
  const data: ICandle[] = [];
  for (let i = 0; i < len; i++) {
    const open = data?.[i - 1]?.close || Math.random() * 10;
    const close = Math.random() * 10;
    const low = open > close
      ? open - Math.random() * open
      : close - Math.random() * close;
    
    const high = close > open
      ? close + Math.random() * close
      : open + Math.random() * open;
  
    const time = (Date.now() + (1000 * i) as any);;
    const candle = { open, close, low, high, time } as ICandle;
    data.push(candle);
  }
  return data;
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
          const hours = arr[4].split(":")
          return `${day} ${month} ${hours[0]}:${hours[1]}`
      }
  }
};

@Component({
  selector: 'tl-futures-chart-card',
  templateUrl: '../../../spot-page/spot-trading-grid/spot-chart-card/spot-chart-card.component.html',
  styleUrls: ['../../../spot-page/spot-trading-grid/spot-chart-card/spot-chart-card.component.scss']
})
export class FuturesChartCardComponent implements AfterViewInit {
  @ViewChild('chart') chartElement: ElementRef | undefined;
  @HostListener('window:resize', ['$event'])
  private onResize = (event: any) => {
      const { offsetWidth, offsetHeight } = this.chartContainer;
      if (this.chart) this.chart.resize(offsetWidth, offsetHeight, true)
  }

  private chart: IChartApi | undefined;
  private candleStickseries: ISeriesApi<"Candlestick"> | undefined;

  constructor(
    // private renderer2: Renderer2,
  ) {}

  get chartContainer() {
    return this.chartElement?.nativeElement;
  }

  ngAfterViewInit(): void {
    // this.createChart();
  }

  private createChart() {
    // if (this.chartContainer.childNodes[1]) {
    //     this.renderer2.removeChild(this.chartContainer, this.chartContainer.childNodes[1]);
    // }
    this.chart = createChart(this.chartContainer, chartOptions);
    this.candleStickseries = this.chart.addCandlestickSeries();
    const data = getRandomData(110);
    this.candleStickseries.setData(data);
  }
}
