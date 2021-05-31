import { Component } from '@angular/core';
import { IMarket, MarketsService } from 'src/app/@core/services/markets.service';

@Component({
  selector: 'tl-buy-sell-card',
  templateUrl: './buy-sell-card.component.html',
  styleUrls: ['./buy-sell-card.component.scss']
})
export class BuySellCardComponent {
    constructor(
      private marketService: MarketsService,
    ) {}

    get selectedMarket(): IMarket {
      return this.marketService.selectedMarket;
    }
}
