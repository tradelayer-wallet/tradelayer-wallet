import { Component, ViewChild, ViewChildren } from '@angular/core';
import { IMarketType, SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';

@Component({
  selector: 'tl-spot-markets-toolbar',
  templateUrl: '../../shared/markets-toolbar.component.html',
  styleUrls: ['../../shared/markets-toolbar.component.scss']
})
export class SpotMarketsToolbarComponent {
    @ViewChildren('marketsTabGroup') marketsTabGroup: any;
 
    constructor(
        private spotMarketsService: SpotMarketsService,
    ) {}

    get marketsTypes() {
        return this.spotMarketsService.marketsTypes;
    }

    get selectedMarketType() {
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
    }

    selectMarket(marketIndex: number) {
        this.spotMarketsService.selectedMarket = this.marketsFromSelectedMarketType[marketIndex];
    }
}
