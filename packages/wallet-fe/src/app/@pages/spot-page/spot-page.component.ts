import { Component } from '@angular/core';
import { MarketsService } from 'src/app/@core/services/markets.service';

@Component({
  selector: 'tl-trading-page',
  templateUrl: './spot-page.component.html',
  styleUrls: ['./spot-page.component.scss']
})
export class SpotPageComponent {
    constructor(
      private marketsService: MarketsService
    ) {}

    get isAvailableMarkets() {
      return !!this.marketsService.marketsTypes.length;
    }
}
