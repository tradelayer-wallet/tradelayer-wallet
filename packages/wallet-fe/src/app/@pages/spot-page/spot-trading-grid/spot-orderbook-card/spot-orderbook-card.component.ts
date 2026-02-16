import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';
import { SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';
import { SpotOrdersService } from 'src/app/@core/services/spot-services/spot-orders.service';
import { P2PSettingsService } from 'src/app/@core/services/p2p-settings.service';
import { P2POrderbookService } from 'src/app/@core/services/p2p-orderbook.service';


export interface PeriodicElement {
  price: number;
  amount: number;
}

@Component({
  selector: 'tl-spot-orderbook-card',
  templateUrl: './orderbook-card.component.html',
  styleUrls: ['./orderbook-card.component.scss']
})

export class SpotOrderbookCardComponent implements OnInit, OnDestroy {
    @ViewChild('sellOrdersContainer') sellOrdersContainer: any;

    displayedColumns: string[] = ['price', 'amount', 'total'];
    clickedRows = new Set<PeriodicElement>();
    constructor(
      private spotOrderbookService: SpotOrderbookService,
      private spotOrdersService: SpotOrdersService,
      private spotMarketsService: SpotMarketsService,
      private p2pSettings: P2PSettingsService,
      private p2pOb: P2POrderbookService,
    ) {}

    get isP2P(): boolean {
      return this.p2pSettings.mode !== 'CENTRAL';
    }

    get upTrend() {
      return this.lastPrice > this.marketPrice;
    }

    get lastPrice() {
      if (this.isP2P) return this.marketPrice;
      return this.spotOrderbookService.lastPrice;
    }

    get marketPrice() {
      if (this.isP2P) return this.p2pOb.getMarketPrice('SPOT', this.selectedMarket?.pairString);
      return this.spotOrderbookService.currentPrice;
    }

    get openedOrders() {
      return this.spotOrdersService.openedOrders;
    }

    get openedBuyOrders() {
      return this.openedOrders.filter(p => {
        const isBuy = p.action === "BUY";
        const matchPropDesired = p.props.id_desired === this.selectedMarket.first_token.propertyId;
        const matchPropForSale = p.props.id_for_sale === this.selectedMarket.second_token.propertyId;
        return isBuy && matchPropDesired && matchPropForSale;
      });
    }

    get openedSellOrders() {
      return this.openedOrders.filter(p => {
        const isSell = p.action === "SELL";
        const matchPropDesired = p.props.id_desired === this.selectedMarket.second_token.propertyId;
        const matchPropForSale = p.props.id_for_sale === this.selectedMarket.first_token.propertyId;
        return isSell && matchPropDesired && matchPropForSale;
      });
    }

    get buyOrderbooks() {
      if (this.isP2P) return this.p2pOb.getLevels('SPOT', this.selectedMarket?.pairString).buy;
      return this.spotOrderbookService.buyOrderbooks;
    }

    get sellOrderbooks() {
      this.scrollToBottom();
      if (this.isP2P) return this.p2pOb.getLevels('SPOT', this.selectedMarket?.pairString).sell;
      return this.spotOrderbookService.sellOrderbooks;
    }

    get selectedMarket() {
      return this.spotMarketsService.selectedMarket;
    }
  
    ngOnInit() {
      if (!this.isP2P) this.spotOrderbookService.subscribeForOrderbook();
    }

    scrollToBottom() {
      if (this.sellOrdersContainer?.nativeElement) {
        this.sellOrdersContainer.nativeElement.scrollTop = this.sellOrdersContainer.nativeElement.scrollHeight;
      }
    }

    ngOnDestroy() {
      if (!this.isP2P) this.spotOrderbookService.endOrderbookSbuscription()
    }

    fillBuySellPrice(price: number) {
      if (price) this.spotOrderbookService.outsidePriceHandler.next(price);
    }

    // haveOpenedOrdersOnThisPrice(isBuy: boolean, price: number) {
    //   const positions = isBuy
    //     ? this.openedBuyOrders
    //     : this.openedSellOrders;
    //   return positions.map(e => e.props.price).some(e => e >= price && (e < price + 0.01));
    // }
}
