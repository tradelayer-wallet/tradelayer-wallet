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

    // -------------------------------------------------------------------------
    // UI helpers (bar color + pending projections)
    // -------------------------------------------------------------------------
    private toNum(v: any): number {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }

    get pendingPositionDelta(): number {
      return this.futuresPositionsService.pendingPositionDelta;
    }

    get pendingUpnlDelta(): number {
      return this.futuresPositionsService.pendingUpnlDelta;
    }

    positionNum(p: IPosition): number {
      return this.toNum(p?.position);
    }

    upnlNum(p: IPosition): number {
      return this.toNum(p?.upnl);
    }

    projectedPosition(p: IPosition): number {
      return this.positionNum(p) + this.pendingPositionDelta;
    }

    projectedUpnl(p: IPosition): number {
      return this.upnlNum(p) + this.pendingUpnlDelta;
    }

    signClass(n: number): string {
      if (n > 0) return 'pos-positive';
      if (n < 0) return 'pos-negative';
      return 'pos-flat';
    }

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
