import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';
import { FuturesOrderbookService } from 'src/app/@core/services/futures-services/futures-orderbook.service';
import { FuturesOrdersService } from 'src/app/@core/services/futures-services/futures-orders.service';


export interface PeriodicElement {
  price: number;
  amount: number;
}

@Component({
  selector: 'tl-futures-orderbook-card',
  templateUrl: '../../../spot-page/spot-trading-grid/spot-orderbook-card/orderbook-card.component.html',
  styleUrls: ['../../../spot-page/spot-trading-grid/spot-orderbook-card/orderbook-card.component.scss']
})

export class FuturesOrderbookCardComponent implements OnInit, OnDestroy {
    @ViewChild('sellOrdersContainer') sellOrdersContainer: any;

    displayedColumns: string[] = ['price', 'amount', 'total'];
    clickedRows = new Set<PeriodicElement>();
    constructor(
      private futuresOrderbookService: FuturesOrderbookService,
      private futuresOrdersService: FuturesOrdersService,
      private futuresMarketService: FuturesMarketService,
    ) {}

    get upTrend() {
      return this.lastPrice > this.marketPrice;
    }

    get lastPrice() {
      return 0;
      return this.futuresOrderbookService.lastPrice;
    }

    get marketPrice() {
      return this.futuresOrderbookService.currentPrice;
    }

    get openedOrders() {
      return this.futuresOrdersService.openedOrders;
    }

    get openedBuyOrders() {
      return this.openedOrders.filter(p => {
        const isBuy = p.action === "BUY";
        const matchContract = p.props.contract_id === this.selectedMarket.contract_id;
        return isBuy && matchContract;
      });
    }

    get openedSellOrders() {
      return this.openedOrders.filter(p => {
        const isSell = p.action === "SELL";
        const matchContract = p.props.contract_id === this.selectedMarket.contract_id;
        return isSell && matchContract;
      });
    }

    get buyOrderbooks() {
      return this.futuresOrderbookService.buyOrderbooks;
    }

    get sellOrderbooks() {
      this.scrollToBottom();
      return this.futuresOrderbookService.sellOrderbooks;
    }

    get selectedMarket() {
      return this.futuresMarketService.selectedMarket;
    }
  
    ngOnInit() {
      this.futuresOrderbookService.subscribeForOrderbook();
    }

    scrollToBottom() {
      if (this.sellOrdersContainer?.nativeElement) {
        this.sellOrdersContainer.nativeElement.scrollTop = this.sellOrdersContainer.nativeElement.scrollHeight;
      }
    }

    ngOnDestroy() {
      this.futuresOrderbookService.endOrderbookSbuscription()
    }

    fillBuySellPrice(price: number) {
      if (price) this.futuresOrderbookService.outsidePriceHandler.next(price);
    }

    // haveOpenedOrdersOnThisPrice(isBuy: boolean, price: number) {
    //   const positions = isBuy
    //     ? this.openedBuyOrders
    //     : this.openedSellOrders;
    //   return positions.map(e => e.props.price).some(e => e >= price && (e < price + 0.01));
    // }
}
