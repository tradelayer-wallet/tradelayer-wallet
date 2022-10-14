import { Component, OnInit } from '@angular/core';

@Component({
  selector: 'tl-futures-positions',
  templateUrl: './futures-positions.component.html',
  styleUrls: ['./futures-positions.component.scss']
})

export class FuturesPositionsComponent implements OnInit {

    displayedColumns: string[] = ['market', 'amount', 'price', 'pnl', 'isBuy', 'close'];
    constructor() {}

    get openedPositions() {
      return [];
    }

    ngOnInit() {}
}
