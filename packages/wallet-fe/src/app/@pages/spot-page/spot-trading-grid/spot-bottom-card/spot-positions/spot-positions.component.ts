import { Component, OnInit } from '@angular/core';
import { ISpotOrder } from 'src/app/@core/services/spot-services/spot-orderbook.service';
import { SpotPositionsService } from 'src/app/@core/services/spot-services/spot-positions.service';

@Component({
  selector: 'tl-spot-positions',
  templateUrl: './spot-positions.component.html',
  styleUrls: ['./spot-positions.component.scss']
})

export class SpotPositionsComponent implements OnInit {
    displayedColumns: string[] = ['market', 'amount', 'price', 'isBuy', 'close'];

    constructor(
      private spotPositionsService: SpotPositionsService
    ) {}

    get openedPositions() {
      return this.spotPositionsService.openedPositions;
    }

    closePosition(uuid: string) {
      this.spotPositionsService.closeOpenedPosition(uuid);
    }

    ngOnInit() {}
}
