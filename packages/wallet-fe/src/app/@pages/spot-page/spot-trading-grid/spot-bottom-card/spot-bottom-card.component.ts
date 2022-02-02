import { Component, OnInit } from '@angular/core';
import { SpotPositionsService } from 'src/app/@core/services/spot-services/spot-positions.service';

@Component({
  selector: 'tl-spot-bottom-card',
  templateUrl: './spot-bottom-card.component.html',
  styleUrls: ['./spot-bottom-card.component.scss']
})

export class SpotBottomCardComponent {
    constructor(
      private spotPositionsService: SpotPositionsService,
    ) {}

    get allOrdersLength() {
      return this.spotPositionsService.openedPositions?.length || 0;
    }
}
