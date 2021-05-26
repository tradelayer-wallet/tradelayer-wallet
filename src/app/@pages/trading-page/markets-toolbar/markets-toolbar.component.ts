import { Component } from '@angular/core';
import { IMarketType, MarketsService } from 'src/app/@core/services/markets.service';

@Component({
  selector: 'tl-markets-toolbar',
  templateUrl: './markets-toolbar.component.html',
  styleUrls: ['./markets-toolbar.component.scss']
})
export class MarketsToolbarComponent {
 
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
        this.marketsService.selectedMarketType = this.marketsTypes[marketTypeIndex]
    }
}
