import { Component } from '@angular/core';
import { FuturesOrdersService } from 'src/app/@core/services/futures-services/futures-orders.service';

@Component({
  selector: 'tl-futures-order-history',
  templateUrl: '../../../../spot-page/spot-trading-grid/spot-bottom-card/spot-order-history/spot-order-history.component.html',
  styleUrls: ['../../../../spot-page/spot-trading-grid/spot-bottom-card/spot-order-history/spot-order-history.component.scss']
})

export class FuturesOrderHistoryComponent {
  displayedColumns: string[] = ['market', 'status', 'amount', 'price', 'isBuy'];

    constructor(
      private futuresOrdersService: FuturesOrdersService,
    ) {}
    
    get orderHistory() {
      return this.futuresOrdersService.orderHistory?.reverse() || [];
    }
}