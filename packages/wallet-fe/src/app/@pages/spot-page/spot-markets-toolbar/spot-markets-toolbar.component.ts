import { Component, ViewChildren, ViewChild} from '@angular/core';
import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';
import { SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';
import { SpotChannelsService } from 'src/app/@core/services/spot-services/spot-channels.service';
import { SpotTradeHistoryService } from 'src/app/@core/services/spot-services/spot-trade-history.service';
import { SpotBuySellCardComponent } from '../spot-trading-grid/spot-buy-sell-card/spot-buy-sell-card.component';




@Component({
  selector: 'tl-spot-markets-toolbar',
  templateUrl: './spot-markets-toolbar.component.html',
  styleUrls: ['./spot-markets-toolbar.component.scss']
})
export class SpotMarketsToolbarComponent {
    @ViewChildren('marketsTabGroup') marketsTabGroup: any;
    @ViewChild(SpotBuySellCardComponent) buySellCard!: SpotBuySellCardComponent;
    constructor(
        private spotMarketsService: SpotMarketsService,
        private spotOrderbookService: SpotOrderbookService,
        private spotChannels: SpotChannelsService,
        private spotHistory: SpotTradeHistoryService
    ) {}

    get marketsTypes() {
        return this.spotMarketsService.spotMarketsTypes;
    }

    get selectedMarketType() {
        // After selectedMarketType setter runs, it sets a default selectedMarket.
        return this.spotMarketsService.selectedMarketType;
    }

    get marketsFromSelectedMarketType() {
        return this.spotMarketsService.marketsFromSelectedMarketType;
    }

    get selectedMarketTypeIndex() {
        return this.spotMarketsService.selectedMarketTypeIndex;
    }

    get selectedMarketIndex() {
        return this.spotMarketsService.selectedMarketIndex;
    }

    selectMarketType(marketTypeIndex: number) {
        this.spotMarketsService.selectedMarketType = this.marketsTypes[marketTypeIndex];
        // After selectedMarketType setter runs, it sets a default selectedMarket.
        if (this.buySellCard) {
            this.buySellCard.forceRefresh();
        }
        const sel = this.spotOrderbookService.selectedMarket;
        if (sel) {
          this.spotOrderbookService.switchSpotMarket(
            sel.first_token.propertyId,
            sel.second_token.propertyId,
            { depth: 50, side: 'both', includeTrades: false }
          );
        }
    }

    selectMarket(marketIndex: number, mtIndex: number){
        this.spotMarketsService.selectedMarket = this.marketsFromSelectedMarketType[marketIndex];
        const sel = this.spotOrderbookService.selectedMarket;
        this.spotChannels.loadOnce();
        this.spotHistory.refreshNow();
        this.spotOrderbookService.switchSpotMarket(
              sel.first_token.propertyId,
              sel.second_token.propertyId,
              { depth: 50, side: 'both', includeTrades: false }
            );
    }
}
