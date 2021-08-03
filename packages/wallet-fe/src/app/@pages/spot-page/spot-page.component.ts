import { Component } from '@angular/core';
import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';

@Component({
  selector: 'tl-trading-page',
  templateUrl: './spot-page.component.html',
  styleUrls: ['./spot-page.component.scss']
})
export class SpotPageComponent {
    constructor(
      private spotMarketsService: SpotMarketsService
    ) {}

    get isAvailableMarkets() {
      return !!this.spotMarketsService.marketsTypes.length;
    }
}
