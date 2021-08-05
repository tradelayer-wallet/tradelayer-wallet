import { Component, ViewChildren } from '@angular/core';
import {  SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';

@Component({
  selector: 'tl-spot-markets-toolbar',
  templateUrl: '../../shared/markets-toolbar/markets-toolbar.component.html',
  styleUrls: ['../../shared/markets-toolbar/markets-toolbar.component.scss']
})
export class SpotMarketsToolbarComponent {
    @ViewChildren('marketsTabGroup') marketsTabGroup: any;
 
    constructor(
        private spotMarketsService: SpotMarketsService,
    ) {}

    get marketsTypes() {
        return this.spotMarketsService.spotMarketsTypes;
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

    selectMarket(marketIndex: number, mtIndex: number) {
        if (this.selectedMarketTypeIndex !== mtIndex) return;
        this.spotMarketsService.selectedMarket = this.marketsFromSelectedMarketType[marketIndex];
    }
}
