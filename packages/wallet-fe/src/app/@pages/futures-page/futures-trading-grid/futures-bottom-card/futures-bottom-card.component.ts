import { Component } from '@angular/core';

@Component({
  selector: 'tl-futures-bottom-card',
  templateUrl: './futures-bottom-card.component.html',
  styleUrls: ['../../../spot-page/spot-trading-grid/spot-bottom-card/spot-bottom-card.component.scss']
})

export class FuturesBottomCardComponent {
    constructor(
      // private spotOrdersService: SpotOrdersService,
      // private spotChannelsService: SpotChannelsService,
      // private spotOrderbookService: SpotOrderbookService,
    ) {}

    get allCommitsLength() {
      return 0;
      // return this.spotChannelsService.channelsCommits?.length || 0;
    }

    get allOrdersLength() {
      return 0;
      // return this.spotOrdersService.openedOrders?.length || 0;
    }

    get allRelayedHistory() {
      return 0;
      // return this.spotOrderbookService.relatedHistoryTrades.length || 0;
    }
}
