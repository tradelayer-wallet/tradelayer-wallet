import { Component, ViewChildren } from '@angular/core';
import { FuturesMarketsService } from 'src/app/@core/services/futures-services/futures-markets.service';

@Component({
  selector: 'tl-futures-markets-toolbar',
  templateUrl: '../../shared/markets-toolbar/markets-toolbar.component.html',
  styleUrls: ['../../shared/markets-toolbar/markets-toolbar.component.scss']
})
export class FuturesMarketsToolbarComponent {
    @ViewChildren('marketsTabGroup') marketsTabGroup: any;
 
    constructor(
        private futuresMarketsService: FuturesMarketsService,
    ) { }

    get marketsTypes() {
        return this.futuresMarketsService.futuresMarketsTypes;
    }

    get selectedMarketType() {
        return this.futuresMarketsService.selectedFuturesMarketType;
    }

    get marketsFromSelectedMarketType() {
        return this.futuresMarketsService.contractsFromSelectedFuturesMarketType;
    }

    get selectedMarketTypeIndex() {
        return this.futuresMarketsService.selectedFutururesMarketTypeIndex;
    }

    get selectedMarketIndex() {
        return this.futuresMarketsService.selectedContractIndex;
    }

    selectMarketType(marketTypeIndex: number) {
        this.futuresMarketsService.selectedFuturesMarketType = this.marketsTypes[marketTypeIndex];
    }

    selectMarket(marketIndex: number, mtIndex: number) {
        if (this.selectedMarketTypeIndex !== mtIndex) return;
        this.futuresMarketsService.selectedContract = this.marketsFromSelectedMarketType[marketIndex];
    }
}
