import { Component, OnDestroy, ChangeDetectionStrategy } from '@angular/core';
import { SpotTradeHistoryService } from 'src/app/@core/services/spot-services/spot-trade-history.service';

@Component({
  selector: 'app-spot-trade-history',
  templateUrl: './spot-trade-history.component.html',
  styleUrls: ['./spot-trade-history.component.scss'],
  changeDetection: ChangeDetectionStrategy.Default
})
export class SpotTradeHistoryComponent implements OnDestroy {
  /** Column order for the <table> */
  displayedColumns: string[] = [
    'block', 'side', 'amount', 'price', 'total', 'role', 'fee', 'tx', 'counterparty'
  ];

  constructor(public spotHistory: SpotTradeHistoryService) {}

  ngOnDestroy(): void {
    // If this component is the only consumer, it's fine to stop the poller.
    // If multiple places use it concurrently, you can remove this.
    this.spotHistory.stop();
  }

  // ------- helpers the template expects -------

  txUrl(r: any): string | null {
    // If you have a proper explorer base, plug it here (and handle testnet).
    // Return null to render a non-link short txid.
    return null;
  }

  shortTx(txid: string): string {
    if (!txid) return '';
    return `${txid.slice(0, 6)}…${txid.slice(-6)}`;
  }

  async copy(addr: string | undefined): Promise<void> {
    if (!addr) return;
    try { await navigator.clipboard.writeText(addr); } catch {}
  }
}
