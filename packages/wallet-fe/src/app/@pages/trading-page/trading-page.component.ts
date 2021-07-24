import { Component } from '@angular/core';
import { MarketsService } from 'src/app/@core/services/markets.service';

@Component({
  selector: 'tl-trading-page',
  templateUrl: './trading-page.component.html',
  styleUrls: ['./trading-page.component.scss']
})
export class TradingPageComponent {
    constructor(
      private marketsService: MarketsService
    ) {}

    get isAvailableMarkets() {
      return !!this.marketsService.marketsTypes.length;
    }
}
