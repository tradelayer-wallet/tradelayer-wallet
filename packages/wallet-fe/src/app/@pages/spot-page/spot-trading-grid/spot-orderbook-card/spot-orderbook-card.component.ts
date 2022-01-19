import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';
import { SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';
import { SpotPositionsService } from 'src/app/@core/services/spot-services/spot-positions.service';


export interface PeriodicElement {
  price: number;
  amount: number;
}

@Component({
  selector: 'tl-spot-orderbook-card',
  templateUrl: '../../../shared/trading-grid/orderbook/orderbook-card.component.html',
  styleUrls: ['../../../shared/trading-grid/orderbook/orderbook-card.component.scss']
})

export class SpotOrderbookCardComponent implements OnInit, OnDestroy {
    @ViewChild('sellOrdersContainer') sellOrdersContainer: any;

    displayedColumns: string[] = ['price', 'amount', 'total'];
    clickedRows = new Set<PeriodicElement>();
    constructor(
      private spotOrderbookService: SpotOrderbookService,
      private spotPositionsService: SpotPositionsService,
      private spotMarketsService: SpotMarketsService,
    ) {}

    get upTrend() {
      const th = this.spotOrderbookService.tradeHistory;
      if (this.spotOrderbookService.tradeHistory.length < 2) return true;
      const {amountForSale, amountDesired } = th[th.length - 2];
      const tradeBeforePrice = (amountForSale / amountDesired).toFixed(4)
      return tradeBeforePrice < this.lastPrice;
    }

    get lastPrice() {
      const th = this.spotOrderbookService.tradeHistory;
      if (!this.spotOrderbookService.tradeHistory.length) return (1).toFixed(4);
      const {amountForSale, amountDesired } = th[th.length -1];
      return (amountForSale / amountDesired).toFixed(4)
    }

    get openedPoisiton() {
      return this.spotPositionsService.openedPositions;
    }

    get openedBuyPositions() {
      return this.openedPoisiton.filter(p => {
        const isBuy = p.isBuy;
        const matchPropDesired = p.propIdDesired === this.selectedMarket.first_token.propertyId;
        const matchPropForSale = p.propIdForSale === this.selectedMarket.second_token.propertyId;
        return isBuy && matchPropDesired && matchPropForSale;
      });
    }

    get openedSellPositions() {
      return this.openedPoisiton.filter(p => {
        const isBuy = !p.isBuy;
        const matchPropDesired = p.propIdDesired === this.selectedMarket.second_token.propertyId;
        const matchPropForSale = p.propIdForSale === this.selectedMarket.first_token.propertyId;
        return isBuy && matchPropDesired && matchPropForSale;
      });
    }

    get buyOrderbooks() {
      return this.spotOrderbookService.buyOrderbooks;
    }

    get sellOrderbooks() {
      this.scrollToBottom();
      return this.spotOrderbookService.sellOrderbooks;
    }

    get selectedMarket() {
      return this.spotMarketsService.selectedMarket;
    }
  
    ngOnInit() {
      this.spotOrderbookService.subscribeForOrderbook();
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
      if (price) this.spotOrderbookService.outsidePriceHandler.next(price);
    }

    haveOpenedPositionOnThisPrice(isBuy: boolean, price: number) {
      const positions = isBuy
        ? this.openedBuyPositions
        : this.openedSellPositions;
      return positions.map(e => e.price).some(e => e >= price && (e < price + 0.01));
    }
}
