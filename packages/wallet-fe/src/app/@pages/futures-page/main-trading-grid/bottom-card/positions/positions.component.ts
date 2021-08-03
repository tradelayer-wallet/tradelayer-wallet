import { Component, OnInit } from '@angular/core';
import { PositionsService } from 'src/app/@core/services/positions.service';

@Component({
  selector: 'tl-positions',
  templateUrl: './positions.component.html',
  styleUrls: ['./positions.component.scss']
})

export class PositionsComponent implements OnInit {
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
