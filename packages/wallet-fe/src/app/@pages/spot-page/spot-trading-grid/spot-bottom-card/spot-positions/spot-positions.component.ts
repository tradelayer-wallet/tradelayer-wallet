import { Component, OnInit } from '@angular/core';
import { PositionsService } from 'src/app/@core/services/spot-services/positions.service';

@Component({
  selector: 'tl-spot-positions',
  templateUrl: './spot-positions.component.html',
  styleUrls: ['./spot-positions.component.scss']
})

export class SpotPositionsComponent implements OnInit {
    displayedColumns: string[] = ['id', 'market', 'amount', 'price', 'isBuy', 'close'];

    constructor(
      private positionsService: PositionsService
    ) {}

    get openedPositions() {
      return this.positionsService.openedPositions;
    }

    closePosition(position: any) {
      this.positionsService.closeOpenedPosition(position)
    }

    ngOnInit() {}
}
