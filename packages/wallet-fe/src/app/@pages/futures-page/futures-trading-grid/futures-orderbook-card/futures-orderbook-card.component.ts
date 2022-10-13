import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';
import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';
import { SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';
import { SpotOrdersService } from 'src/app/@core/services/spot-services/spot-orders.service';


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
      // private spotOrderbookService: SpotOrderbookService,
      // private spotOrdersService: SpotOrdersService,
      private futuresMarketService: FuturesMarketService,
    ) {}

    get upTrend() {
      return this.lastPrice > this.marketPrice;
    }

    get lastPrice() {
      return 0;
      // return this.spotOrderbookService.lastPrice;
    }

    get marketPrice() {
      return 1;
      // return this.spotOrderbookService.currentPrice;
    }

    get openedOrders() {
      return []
      // return this.spotOrdersService.openedOrders;
    }

    get openedBuyOrders() {
      return [];
      // return this.openedOrders.filter(p => {
      //   const isBuy = p.action === "BUY";
      //   const matchPropDesired = p.props.id_desired === this.selectedMarket.first_token.propertyId;
      //   const matchPropForSale = p.props.id_for_sale === this.selectedMarket.second_token.propertyId;
      //   return isBuy && matchPropDesired && matchPropForSale;
      // });
    }

    get openedSellOrders() {
      return [];
      // return this.openedOrders.filter(p => {
      //   const isSell = p.action === "SELL";
      //   const matchPropDesired = p.props.id_desired === this.selectedMarket.second_token.propertyId;
      //   const matchPropForSale = p.props.id_for_sale === this.selectedMarket.first_token.propertyId;
      //   return isSell && matchPropDesired && matchPropForSale;
      // });
    }

    get buyOrderbooks() {
      return [];
      // return this.spotOrderbookService.buyOrderbooks;
    }

    get sellOrderbooks() {
      this.scrollToBottom();
      return [];
      // return this.spotOrderbookService.sellOrderbooks;
    }

    get selectedMarket() {
      return this.futuresMarketService.selectedMarket;
    }
  
    ngOnInit() {
      // this.spotOrderbookService.subscribeForOrderbook();
    }

    scrollToBottom() {
      if (this.sellOrdersContainer?.nativeElement) {
        this.sellOrdersContainer.nativeElement.scrollTop = this.sellOrdersContainer.nativeElement.scrollHeight;
      }
    }

    ngOnDestroy() {
      // this.spotOrderbookService.endOrderbookSbuscription()
    }

    fillBuySellPrice(price: number) {
      // if (price) this.spotOrderbookService.outsidePriceHandler.next(price);
    }

    // haveOpenedOrdersOnThisPrice(isBuy: boolean, price: number) {
    //   const positions = isBuy
    //     ? this.openedBuyOrders
    //     : this.openedSellOrders;
    //   return positions.map(e => e.props.price).some(e => e >= price && (e < price + 0.01));
    // }
}
