import { Component, OnDestroy, OnInit } from '@angular/core';
import { OrderbookService } from 'src/app/@core/services/orderbook.service';
import { PositionsService } from 'src/app/@core/services/positions.service';


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
      private positionsService: PositionsService
    ) {}

    get openedPoisiton() {
      return this.positionsService.openedPositions;
    }

    get openedBuyPositions() {
      return this.openedPoisiton.filter(p => p.isBuy);
    }

    get openedSellPositions() {
      return this.openedPoisiton.filter(p => !p.isBuy);
    }

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

    fillBuySellPrice(price: number) {
      if (price) this.orderbookService.outsidePriceHandler.next(price);
    }

    haveOpenedPositionOnThisPrice(isBuy: boolean, price: number) {
      const myPositoins = isBuy
        ? this.openedBuyPositions
        : this.openedSellPositions;
      return myPositoins.map(e => e.price).some(e => e >= price && (e < price + 0.01))
    }
}
