import { Component, OnInit } from '@angular/core';

import { SpotOrdersService } from 'src/app/@core/services/spot-services/spot-orders.service';

@Component({
  selector: 'tl-spot-orders',
  templateUrl: './spot-orders.component.html',
  styleUrls: ['./spot-orders.component.scss']
})

export class SpotOrdersComponent implements OnInit {
    displayedColumns: string[] = ['market', 'amount', 'price', 'isBuy', 'close'];

    constructor(
      private spotOrdersService: SpotOrdersService,
    ) {}

    get openedOrders() {
      return this.spotOrdersService.openedOrders;
    }

    closeOrder(uuid: string) {
      this.spotOrdersService.closeOpenedOrder(uuid);
    }

    ngOnInit() {}
}
