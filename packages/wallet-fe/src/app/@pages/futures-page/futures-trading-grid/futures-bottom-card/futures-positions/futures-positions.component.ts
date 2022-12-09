import { Component, OnInit } from '@angular/core';
import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';
import { FuturesPositionsService, IPosition } from 'src/app/@core/services/futures-services/futures-positions.service';

@Component({
  selector: 'tl-futures-positions',
  templateUrl: './futures-positions.component.html',
  styleUrls: ['./futures-positions.component.scss']
})

export class FuturesPositionsComponent implements OnInit {

    displayedColumns: string[] = ['market', 'position', 'price', 'liquidation', 'margin', 'upnl', 'close'];
    constructor(
      private futuresPositionsService: FuturesPositionsService,
      private futuresMarketService: FuturesMarketService,
    ) {}

    get openedPositions() {
      if (this.futuresPositionsService.openedPosition) {
        return [this.futuresPositionsService.openedPosition];
      } else {
        return [];
      }
    }

    get marketName() {
      return this.futuresMarketService.selectedMarket.contractName;
    }
  
    ngOnInit() {
      this.futuresPositionsService.onInit();
    }

    closePosition(position: IPosition) {
      console.log("CLOSE");
      console.log(position);
    }
}
