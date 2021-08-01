import { Component, OnInit } from '@angular/core';
import { PositionsService } from 'src/app/@core/services/positions.service';

@Component({
  selector: 'tl-positions',
  templateUrl: './positions.component.html',
  styleUrls: ['./positions.component.scss']
})

export class PositionsComponent implements OnInit {
    displayedColumns: string[] = ['id', 'amount', 'price', 'isBuy'];

    constructor(
      private positions: PositionsService
    ) {}

    get openedPositions() {
      return this.positions.openedPositions;
    }
  
    ngOnInit() {}
}
