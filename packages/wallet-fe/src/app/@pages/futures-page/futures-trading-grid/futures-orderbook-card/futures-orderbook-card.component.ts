import { Component, OnDestroy, OnInit } from '@angular/core';
import { FuturesMarketsService } from 'src/app/@core/services/futures-services/futures-markets.service';
import { FuturesOrderbookService } from 'src/app/@core/services/futures-services/futures-orederbook.service';
// import { PositionsService } from 'src/app/@core/services/spot-services/positions.service';


export interface PeriodicElement {
  price: number;
  amount: number;
}

@Component({
  selector: 'tl-futures-orderbook-card',
  templateUrl: '../../../shared/trading-grid/orderbook/orderbook-card.component.html',
  styleUrls: ['../../../shared/trading-grid/orderbook/orderbook-card.component.scss']
})

export class FuturesOrderbookCardComponent implements OnInit, OnDestroy {
    displayedColumns: string[] = ['price', 'amount', 'total'];
    clickedRows = new Set<PeriodicElement>();
    upTrend: boolean = false;
    constructor(
      private futuresOrderbookService: FuturesOrderbookService,
      // private positionsService: PositionsService,
      private futuresMarketsService: FuturesMarketsService,
    ) {}

    // get openedPoisiton() {
    //   return this.positionsService.openedPositions;
    // }

    get openedBuyPositions() {
      // return this.openedPoisiton.filter(p => {
      //   const isBuy = p.isBuy;
      //   const matchPropDesired = p.propIdDesired === this.selectedMarket.first_token.propertyId;
      //   const matchPropForSale = p.propIdForSale === this.selectedMarket.second_token.propertyId;
      //   return isBuy && matchPropDesired && matchPropForSale;
      // });
      return [];
    }

    get openedSellPositions() {
      // return this.openedPoisiton.filter(p => {
      //   const isBuy = !p.isBuy;
      //   const matchPropDesired = p.propIdDesired === this.selectedMarket.second_token.propertyId;
      //   const matchPropForSale = p.propIdForSale === this.selectedMarket.first_token.propertyId;
      //   return isBuy && matchPropDesired && matchPropForSale;
      // });
      return [];
    }

    get buyOrderbooks() {
      return this.futuresOrderbookService.buyOrderbooks;
    }

    get sellOrderbooks() {
      return this.futuresOrderbookService.sellOrderbooks;
    }

    get selectedMarket() {
      return this.futuresMarketsService.selectedContract;
    }
  
    ngOnInit() {
      this.futuresOrderbookService.subscribeForOrderbook();
    }

    ngOnDestroy() {
      // this.futuresOrderbookService.endOrderbookSbuscription()
    }

    fillBuySellPrice(price: number) {
      // if (price) this.spotOrderbookService.outsidePriceHandler.next(price);
    }

    haveOpenedPositionOnThisPrice(isBuy: boolean, price: number) {
      // const positions = isBuy
      //   ? this.openedBuyPositions
      //   : this.openedSellPositions;
      // return positions.map((e: any) => e.price).some(e => e >= price && (e < price + 0.01));
    }
}
