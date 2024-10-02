import { Component } from '@angular/core';
import { SpotOrdersService } from 'src/app/@core/services/spot-services/spot-orders.service';

@Component({
  selector: 'tl-spot-order-history',
  templateUrl: './spot-order-history.component.html',
  styleUrls: ['./spot-order-history.component.scss']
})

export class SpotOrderHistoryComponent {
    displayedColumns: string[] = ['date', 'market', 'status', 'amount', 'price', 'isBuy'];

    constructor(
      private spotOrdersService: SpotOrdersService,
    ) {}

    get orderHistory() {
      const history = this.spotOrdersService.orderHistory?.reverse() || [];
      console.log('order history '+JSON.stringify(history))
      return history
    }
}