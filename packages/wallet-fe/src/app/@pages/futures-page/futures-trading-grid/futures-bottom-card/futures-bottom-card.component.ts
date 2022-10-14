import { Component } from '@angular/core';
import { FuturesOrderbookService } from 'src/app/@core/services/futures-services/futures-orderbook.service';
import { FuturesOrdersService } from 'src/app/@core/services/futures-services/futures-orders.service';

@Component({
  selector: 'tl-futures-bottom-card',
  templateUrl: './futures-bottom-card.component.html',
  styleUrls: ['../../../spot-page/spot-trading-grid/spot-bottom-card/spot-bottom-card.component.scss']
})

export class FuturesBottomCardComponent {
    constructor(
      private futuresOrdersService: FuturesOrdersService,
      private futuresOrderbookService: FuturesOrderbookService,
    ) {}

    get allOrdersLength() {
      return this.futuresOrdersService.openedOrders?.length || 0;
    }

    get allRelayedHistory() {
      return this.futuresOrderbookService.relatedHistoryTrades.length || 0;
    }
}
