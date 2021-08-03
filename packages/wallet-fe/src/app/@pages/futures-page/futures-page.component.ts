import { Component } from '@angular/core';
import { MarketsService } from 'src/app/@core/services/markets.service';

@Component({
  selector: 'tl-futures-page',
  templateUrl: './futures-page.component.html',
  styleUrls: ['./futures-page.component.scss']
})
export class FuturesPageComponent {
    constructor(
      private marketsService: MarketsService
    ) {}

    get isAvailableMarkets() {
      return !!this.marketsService.marketsTypes.length;
    }
}
