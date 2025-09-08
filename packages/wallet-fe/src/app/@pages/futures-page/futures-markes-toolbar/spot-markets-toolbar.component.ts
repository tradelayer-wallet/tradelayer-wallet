import { Component, ViewChildren,ViewChild } from '@angular/core';
import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';
import { FuturesOrderbookService } from 'src/app/@core/services/futures-services/futures-orderbook.service';
import { FuturesChannelsService } from 'src/app/@core/services/futures-services/futures-channels.service';
import { FuturesTradeHistoryService } from 'src/app/@core/services/futures-services/futures-trade-history.service';
import { FuturesBuySellCardComponent } from '../futures-trading-grid/futures-buy-sell-card/futures-buy-sell-card.component';


@Component({
  selector: 'tl-futures-markets-toolbar',
  templateUrl: '../../spot-page/spot-markets-toolbar/spot-markets-toolbar.component.html',
  styleUrls: ['../../spot-page/spot-markets-toolbar/spot-markets-toolbar.component.scss']
})

export class FuturesMarketsToolbarComponent {
    @ViewChildren('marketsTabGroup') marketsTabGroup: any;
    @ViewChild(FuturesBuySellCardComponent) buySellCard!: FuturesBuySellCardComponent;
 
    constructor(
        private futuresMarketsService: FuturesMarketService,
        private futuresOrderbookService: FuturesOrderbookService,
        private futChannels: FuturesChannelsService,
        private futHistory: FuturesTradeHistoryService
    ) {}

    get marketsTypes() {
        return this.futuresMarketsService.futuresMarketsTypes;
    }

    get selectedMarketType() {
        return this.futuresMarketsService.selectedMarketType;
    }

    get marketsFromSelectedMarketType() {
        return this.futuresMarketsService.marketsFromSelectedMarketType;
    }

    get selectedMarketTypeIndex() {
        return this.futuresMarketsService.selectedMarketTypeIndex;
    }

    get selectedMarketIndex() {
        return this.futuresMarketsService.selectedMarketIndex;
    }

    selectMarketType(marketTypeIndex: number) {
        this.futuresMarketsService.selectedMarketType = this.marketsTypes[marketTypeIndex];
        if (this.buySellCard) {
            this.buySellCard.forceRefresh();
        }
        const sel = this.futuresOrderbookService.selectedMarket;
        if (sel) {
          this.futuresOrderbookService.switchMarket(
            'FUTURES',
            sel.contract_id,
            { depth: 50, side: 'both', includeTrades: false }
          );
        }
    }

    selectMarket(marketIndex: number, mtIndex: number) {
        //if (this.selectedMarketTypeIndex !== mtIndex) return;
        this.futuresMarketsService.selectedMarket = this.marketsFromSelectedMarketType[marketIndex];
        this.futChannels.loadOnce();
        this.futHistory.refreshNow();
        const sel = this.futuresOrderbookService.selectedMarket;
        this.futuresOrderbookService.switchMarket(
          'FUTURES',
          sel.contract_id,
          { depth: 50, side: 'both', includeTrades: false }
        );
    }
}
