import { Component, ViewChildren } from '@angular/core';
import { FuturesMarketsService } from 'src/app/@core/services/markets-service/futures-markets.service';

@Component({
  selector: 'tl-futures-markets-toolbar',
  templateUrl: '../../shared/markets-toolbar.component.html',
  styleUrls: ['../../shared/markets-toolbar.component.scss']
})
export class FuturesMarketsToolbarComponent {
    @ViewChildren('marketsTabGroup') marketsTabGroup: any;
 
    constructor(
        private futuresMarketsService: FuturesMarketsService,
    ) { }

    get marketsTypes() {
        return this.futuresMarketsService.marketsTypes;
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
    }

    selectMarket(marketIndex: number) {
        this.futuresMarketsService.selectedMarket = this.marketsFromSelectedMarketType[marketIndex];
    }
}
