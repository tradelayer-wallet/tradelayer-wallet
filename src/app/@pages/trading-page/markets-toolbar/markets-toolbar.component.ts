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

    get marketsFromSelectedMarketType () {
        return this.marketsService.marketsFromSelectedMarketType;
    }

    selectMarketType(marketTypeIndex: number) {
        this.marketsService.selectedMarketType = this.marketsTypes[marketTypeIndex];
        this.marketsTabGroup.forEach((gr: any) => gr.selectedIndex = 0);
    }

    selectMarket(marketIndex: number) {
        this.marketsService.selectedMarket = this.marketsFromSelectedMarketType[marketIndex];
    }
}
