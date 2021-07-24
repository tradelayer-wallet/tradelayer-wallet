import { Component, OnDestroy, OnInit } from '@angular/core';
import { OrderbookService } from 'src/app/@core/services/orderbook.service';


export interface PeriodicElement {
  price: number;
  amount: number;
}

@Component({
  selector: 'tl-orderbook-card',
  templateUrl: './orderbook-card.component.html',
  styleUrls: ['./orderbook-card.component.scss']
})

export class OrderbookCardComponent implements OnInit, OnDestroy {
    displayedColumns: string[] = ['price', 'amount', 'total'];
    clickedRows = new Set<PeriodicElement>();
    upTrend: boolean = false;
    constructor(
      private orderbookService: OrderbookService,
    ) {}

    get buyOrderbooks() {
      return this.orderbookService.buyOrderbooks;
    }

    get sellOrderbooks() {
      return this.orderbookService.sellOrderbooks;
    }

    ngOnInit() {
      this.orderbookService.subscribeForOrderbook();
    }

    ngOnDestroy() {
      this.orderbookService.endOrderbookSbuscription()
    }

    fillBuySellPrice(row: any) {
      const { price } = row;
      if (price) this.orderbookService.outsidePriceHandler.next(price);
    }
}
