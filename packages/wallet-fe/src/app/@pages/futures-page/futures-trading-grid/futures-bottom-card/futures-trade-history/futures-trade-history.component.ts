// futures-trade-history.component.ts
import { Component, OnDestroy, ChangeDetectionStrategy } from '@angular/core';
import { FuturesTradeHistoryService } from 'src/app/@core/services/futures-services/futures-trade-history.service';

@Component({
  selector: 'app-futures-trade-history',
  templateUrl: './futures-trade-history.component.html',
  styleUrls: ['../../../../spot-page/spot-trading-grid/spot-bottom-card/spot-trade-history/spot-trade-history.component.scss'],
  changeDetection: ChangeDetectionStrategy.Default
})
export class FuturesTradeHistoryComponent implements OnDestroy {
  displayedColumns: string[] = ['block', 'side', 'amount', 'price', 'total', 'role', 'fee', 'tx', 'counterparty'];

  constructor(public futuresHistory: FuturesTradeHistoryService) {}

  ngOnDestroy(): void {
    this.futuresHistory.stop();
  }

  shortTx(txid: string) { return txid ? `${txid.slice(0,6)}…${txid.slice(-6)}` : ''; }
  txUrl(_row: any) { return null; } // plug explorer if you have one
  copy(addr?: string) { if (addr) navigator.clipboard.writeText(addr).catch(() => {}); }
}
