import { Component } from '@angular/core';
import { SpotChannelsService } from 'src/app/@core/services/spot-services/spot-channels.service';
import { SpotOrdersService } from 'src/app/@core/services/spot-services/spot-orders.service';

@Component({
  selector: 'tl-spot-bottom-card',
  templateUrl: './spot-bottom-card.component.html',
  styleUrls: ['./spot-bottom-card.component.scss']
})

export class SpotBottomCardComponent {
    constructor(
      private spotOrdersService: SpotOrdersService,
      private spotChannelsService: SpotChannelsService,
    ) {}

    get allCommitsLength() {
      return this.spotChannelsService.channelsCommits?.length || 0;
    }

    get allOrdersLength() {
      return this.spotOrdersService.openedOrders?.length || 0;
    }
}
