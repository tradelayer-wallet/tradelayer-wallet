import { Component, OnInit, OnDestroy } from '@angular/core';
import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';
import { FuturesPositionsService, IPosition } from 'src/app/@core/services/futures-services/futures-positions.service';

@Component({
  selector: 'tl-futures-positions',
  templateUrl: './futures-positions.component.html',
  styleUrls: ['./futures-positions.component.scss']
})
export class FuturesPositionsComponent implements OnInit, OnDestroy {
  displayedColumns: string[] = ['market', 'position', 'price', 'liquidation', 'margin', 'upnl', 'close'];

  constructor(
    private futuresPositionsService: FuturesPositionsService,
    private futuresMarketService: FuturesMarketService
  ) {}

  private toNum(v: any): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  get activeContractId(): number {
    return this.futuresMarketService.selectedMarket?.contractId;
  }

  get pendingPositionDelta(): number {
    const cid = this.activeContractId;
    return cid != null
      ? this.futuresPositionsService.pendingPositionDeltaByContract[cid] ?? 0
      : 0;
  }

  get pendingUpnlDelta(): number {
    const cid = this.activeContractId;
    return cid != null
      ? this.futuresPositionsService.pendingUpnlDeltaByContract[cid] ?? 0
      : 0;
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

  get openedPositions(): IPosition[] {
    return this.futuresPositionsService.openedPosition
      ? [this.futuresPositionsService.openedPosition]
      : [];
  }

  get marketName(): string {
    return this.futuresMarketService.selectedMarket.contractName;
  }

  ngOnInit() {
    const addr = this.futuresPositionsService.activeAddress;
    const cid = this.activeContractId;
    if (addr && cid != null) {
      this.futuresPositionsService.onInit(addr, cid);
    }
  }

  ngOnDestroy() {
    // service cleans itself up
  }

  closePosition(position: IPosition) {
    console.log('CLOSE', position);
  }
}
