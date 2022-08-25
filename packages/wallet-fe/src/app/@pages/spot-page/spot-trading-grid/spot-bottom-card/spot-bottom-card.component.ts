import { Component } from '@angular/core';
import { SpotOrdersService } from 'src/app/@core/services/spot-services/spot-orders.service';

@Component({
  selector: 'tl-spot-bottom-card',
  templateUrl: './spot-bottom-card.component.html',
  styleUrls: ['./spot-bottom-card.component.scss']
})

export class SpotBottomCardComponent {
    constructor(
      private spotOrdersService: SpotOrdersService,
    ) {}

    get allOrdersLength() {
      return this.spotOrdersService.openedOrders?.length || 0;
    }
}
