import { Component } from '@angular/core';
import { FuturesMarketsService } from 'src/app/@core/services/futures-services/futures-markets.service';

@Component({
  selector: 'tl-futures-page',
  templateUrl: './futures-page.component.html',
  styleUrls: ['./futures-page.component.scss']
})
export class FuturesPageComponent {
    constructor(
      private futuresMarketsService: FuturesMarketsService,
    ) {}

    get isAvailableMarkets() {
      return !!this.futuresMarketsService.marketsTypes.length;
    }
}
