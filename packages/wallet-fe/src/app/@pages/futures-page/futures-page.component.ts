import { Component } from '@angular/core';
import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';

@Component({
  selector: 'tl-futures-page',
  templateUrl: './futures-page.component.html',
  styleUrls: ['./futures-page.component.scss']
})
export class FuturesPageComponent {
    constructor(
      private spotMarketsService: SpotMarketsService
    ) {}

    get isAvailableMarkets() {
      return !!this.spotMarketsService.marketsTypes.length;
    }
}
