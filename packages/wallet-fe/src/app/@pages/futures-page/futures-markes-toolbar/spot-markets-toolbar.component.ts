import { Component, ViewChildren } from '@angular/core';
import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';

@Component({
  selector: 'tl-futures-markets-toolbar',
  templateUrl: '../../spot-page/spot-markets-toolbar/spot-markets-toolbar.component.html',
  styleUrls: ['../../spot-page/spot-markets-toolbar/spot-markets-toolbar.component.scss']
})

export class FuturesMarketsToolbarComponent {
    @ViewChildren('marketsTabGroup') marketsTabGroup: any;
 
    constructor(
        private futuresMarketsService: FuturesMarketService,
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
    }

    selectMarket(marketIndex: number, mtIndex: number) {
        if (this.selectedMarketTypeIndex !== mtIndex) return;
        this.futuresMarketsService.selectedMarket = this.marketsFromSelectedMarketType[marketIndex];
    }
}
