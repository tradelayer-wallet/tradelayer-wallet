import { Component } from '@angular/core';
import { SpotOrdersService } from 'src/app/@core/services/spot-services/spot-orders.service';

@Component({
  selector: 'tl-spot-order-history',
  templateUrl: './spot-order-history.component.html',
  styleUrls: ['./spot-order-history.component.scss']
})

export class SpotOrderHistoryComponent {
    displayedColumns: string[] = ['market', 'status', 'amount', 'price', 'isBuy'];

    constructor(
      private spotOrdersService: SpotOrdersService,
    ) {}

    get orderHistory() {
      return this.spotOrdersService.orderHistory?.reverse() || [];
    }
}