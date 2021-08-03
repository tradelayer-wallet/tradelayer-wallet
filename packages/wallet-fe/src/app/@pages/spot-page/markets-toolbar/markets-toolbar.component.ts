import { Component, ViewChild, ViewChildren } from '@angular/core';
import { IMarketType, MarketsService } from 'src/app/@core/services/markets.service';

@Component({
  selector: 'tl-markets-toolbar',
  templateUrl: './markets-toolbar.component.html',
  styleUrls: ['./markets-toolbar.component.scss']
})
export class MarketsToolbarComponent {
    @ViewChildren('marketsTabGroup') marketsTabGroup: any;
 
    constructor(
        private marketsService: MarketsService,
    ) {}

    get marketsTypes() {
        return this.marketsService.marketsTypes;
    }

    get selectedMarketType() {
        return this.marketsService.selectedMarketType;
    }

    get marketsFromSelectedMarketType() {
        return this.marketsService.marketsFromSelectedMarketType;
    }

    get selectedMarketTypeIndex() {
        return this.marketsService.selectedMarketTypeIndex;
    }

    get selectedMarketIndex() {
        return this.marketsService.selectedMarketIndex;
    }

    selectMarketType(marketTypeIndex: number) {
        this.marketsService.selectedMarketType = this.marketsTypes[marketTypeIndex];
    }

    selectMarket(marketIndex: number) {
        this.marketsService.selectedMarket = this.marketsFromSelectedMarketType[marketIndex];
    }
}
