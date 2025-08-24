import { AuthService } from 'src/app/@core/services/auth.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { Subscription } from 'rxjs';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { ToastrService } from 'ngx-toastr';
import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { FuturesChannelsService } from 'src/app/@core/services/futures-services/futures-channels.service';
import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';
import { DialogService } from 'src/app/@core/services/dialogs.service';
import { TxsService } from 'src/app/@core/services/txs.service';
import { ENCODER } from 'src/app/utils/payloads/encoder';
import { BehaviorSubject, combineLatest } from 'rxjs';
import { filter, shareReplay, switchMap, tap } from 'rxjs/operators';


interface ChannelBalanceRow {
  channel: string;
  column: 'A' | 'B';
  propertyId: number;
  amount: number;
  participants?: { A?: string; B?: string };
  counterparty?: string;
  lastCommitmentBlock?: number;
}

@Component({
  selector: 'tl-futures-commits',
  templateUrl: './futures-commits.component.html',
  styleUrls: ['./futures-commits.component.scss']
})
export class FuturesChannelsComponent implements OnInit {

  displayedColumns = ['property', 'column', 'channel', 'counterparty', 'amount', 'block', 'actions'];

  loading = false;
  working = false;                   // prevent double clicks while building/sending
  error?: string;
  rows: ChannelBalanceRow[] = [];
    private sub?: Subscription;
    private address: string
    private propertyId: number
  constructor(
    private futSvc: FuturesChannelsService,
    private auth: AuthService,
    private futMkts: FuturesMarketService,
    private dialogs: DialogService,
    private txs: TxsService,
    private toastrService: ToastrService
  ) {}

address$ = new BehaviorSubject<string>('');
/** Use your collateral property or whatever key your BE expects for futures channel balances */

refreshFuturesCommitChannels(): void { this.futSvc.refreshFuturesChannels(); }

  ngOnInit() {
    this.refreshFuturesCommitChannels()
  }

get activeChannelsCommits() {
  return this.futSvc.channelsCommits;
}

get total(): number {
  return this.activeChannelsCommits
    .reduce((s, r) => s + (Number.isFinite(r?.amount) ? Number(r.amount) : 0), 0);
}


  private resolveAddress(): string {
    // futures-buy-sell uses auth.walletAddresses[0]
    return this.auth.walletAddresses?.[0] ?? '';
  }

  private resolvePropertyId(): number | undefined {
    // same source as the buy/sell card: selected futures market collateral
    return this.futMkts.selectedMarket?.collateral?.propertyId;
  }

  copy(value?: string | null) {
    if (!value) return;
    navigator.clipboard?.writeText(value).catch(() => {});
  }

  // ----- Transfer via DialogsService -----
  transfer(row: ChannelBalanceRow) {
    const data = {
      mode: 'channel-transfer',
      address: this.address,
      channel: row.channel,
      column: row.column,
      propertyId: row.propertyId,
      maxAmount: row.amount,
      counterparty: row.counterparty,
      participants: row.participants
    };

    const ref = (this.dialogs as any).openTransfer
      ? (this.dialogs as any).openTransfer(data)
      : (this.dialogs as any).open?.(/* component */ undefined, { data });

    if (ref?.afterClosed) {
      ref.afterClosed().subscribe((res: any) => {
      this.futSvc.loadOnce()
      });
    }
  }

  // ----- Withdraw builds the tx directly -----
  async withdraw(row: ChannelBalanceRow) {
    if (this.working) return;
    if (!row?.amount || row.amount <= 0) return;

    try {
      this.working = true;
      this.address = this.resolveAddress()

      // Map column: A -> 0, B -> 1
      const columnNum = row.column === 'A' ? 0 : 1;

      // Build withdrawal payload (full-row amount; not "withdrawAll")
      const payload = ENCODER.encodeWithdrawal({
        withdrawAll: 0,
        propertyId: row.propertyId,
        amountOffered: row.amount,
        column: columnNum,
        channelAddress: row.channel
      });

      // For TL protocol ops, the reference output is the channel address.
      const buildCfg = {
        fromKeyPair: { address: this.address },
        toKeyPair:   { address: row.channel },
        payload
      };

      const res = await this.txs.buildSingSendTx(buildCfg as any);
      if (res?.error) throw new Error(res.error);
      this.toastrService.success(`Withdrawal TX: ${res.data}`, 'Success');

      // Refresh (row may shrink or disappear)
      this.futSvc.loadOnce()
    } catch (err: any) {
      console.error('[Futures][Withdraw] error:', err?.message || err);
      this.error = err?.message || 'Withdraw failed';
    } finally {
      this.working = false;
    }
  }

  async withdrawAll() {
  if (this.working) return;

  // pick rows currently shown; if this.propertyId is set, rows are likely already filtered,
  // but we'll defensively filter again.
  const targetRows = (this.activeChannelsCommits || []).filter(r =>
    (!this.propertyId && r.amount > 0) ||
    (this.propertyId != null && r.propertyId === this.propertyId && r.amount > 0)
  );

  if (!targetRows.length) return;

  this.working = true;
  this.error = undefined;

  try {
    let ok = 0, fail = 0;

    // Process sequentially to avoid RPC/mempool bursts
    for (const row of targetRows) {
      const columnNum = row.column === 'A' ? 0 : 1;
            this.address = this.resolveAddress()

      // withdrawAll=1 tells protocol to withdraw entire balance for this property on that column
      const payload = ENCODER.encodeWithdrawal({
        withdrawAll: 1,
        propertyId: row.propertyId,
        // amountOffered is ignored by withdrawAll in protocol; passing current visible amount is harmless
        amountOffered: row.amount,
        column: columnNum,
        channelAddress: row.channel
      });

      const buildCfg = {
        fromKeyPair: { address: this.address }, // wallet
        toKeyPair:   { address: row.channel },  // channel target
        payload
      };

        const res = await this.txs.buildSingSendTx(buildCfg as any);
        if (res?.error) {
          console.error('[WithdrawAll] item failed:', row, res.error);
          return this.toastrService.error('WithdrawalAll failed: '+res.error)
        } 
      // small delay to be gentle on node/mempool
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`[WithdrawAll] done: ok=${ok} fail=${fail}`);
    this.futSvc.loadOnce(); // refresh table (rows may shrink/disappear)
    return true
  } catch (err: any) {
    this.error = err?.message || 'Withdraw All failed';
    return console.error('[WithdrawAll] error:', this.error);
  } finally {
    this.working = false;
  }
}


  transferAll() {
    // keep simple for now
    if (!this.activeChannelsCommits.length) return;
    this.transfer(this.activeChannelsCommits[0]);
  }

  trackByChan = (_: number, r: ChannelBalanceRow) => `${r.channel}:${r.propertyId}:${r.column}`;
}
