import { Component, OnInit } from '@angular/core';
import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';

@Component({
  templateUrl: './futures-page.component.html',
  styleUrls: ['../spot-page/spot-page.component.scss']
})
export class FuturesPageComponent implements OnInit {
    constructor(
      private futuresMarketService: FuturesMarketService,
    ) {}

    get isAvailableMarkets() {
      return !!this.futuresMarketService.futuresMarketsTypes.length;
    }

    ngOnInit() {
      this.getMarkets();
    }

    private getMarkets() {
      const marketsExists = this.futuresMarketService?.futuresMarketsTypes?.length;
      if (!marketsExists) this.futuresMarketService.getMarkets();
    }
}
