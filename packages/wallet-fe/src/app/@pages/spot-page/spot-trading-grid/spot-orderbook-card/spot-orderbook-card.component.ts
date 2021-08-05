import { Component, OnDestroy, OnInit } from '@angular/core';
import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';
import { SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';
import { PositionsService } from 'src/app/@core/services/spot-services/positions.service';


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
    displayedColumns: string[] = ['price', 'amount', 'total'];
    clickedRows = new Set<PeriodicElement>();
    upTrend: boolean = false;
    constructor(
      private spotOrderbookService: SpotOrderbookService,
      private positionsService: PositionsService,
      private spotMarketsService: SpotMarketsService,
    ) {}

    get openedPoisiton() {
      return this.positionsService.openedPositions;
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
      return this.spotOrderbookService.sellOrderbooks;
    }

    get selectedMarket() {
      return this.spotMarketsService.selectedMarket;
    }
  
    ngOnInit() {
      this.spotOrderbookService.subscribeForOrderbook();
    }

    ngOnDestroy() {
      this.spotOrderbookService.endOrderbookSbuscription()
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
