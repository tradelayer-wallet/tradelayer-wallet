import { Component, OnInit } from '@angular/core';
import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';

@Component({
  selector: 'tl-trading-page',
  templateUrl: './spot-page.component.html',
  styleUrls: ['./spot-page.component.scss']
})
export class SpotPageComponent implements OnInit {
    constructor(
      private spotMarketsService: SpotMarketsService
    ) {}

    get isAvailableMarkets() {
      return !!this.spotMarketsService.spotMarketsTypes.length;
    }

    ngOnInit() {
      this.getMarkets();
    }

    private getMarkets() {
      const marketsExists = this.spotMarketsService?.spotMarketsTypes?.length;
      if (!marketsExists) this.spotMarketsService.getMarkets();
    }
}
