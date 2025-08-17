import { Component, OnInit } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { AuthService } from 'src/app/@core/services/auth.service';
import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';

interface FuturesTradeRecord {
  buyerPosition: boolean | string;
  sellerPosition: boolean | string;
  buyerFee?: number;
  sellerFee?: number;
  contractId: number;
  amount: number;
  price: number;
  buyerAddress: string;
  sellerAddress: string;
  sellerTx?: string;
  buyerTx?: string;
  block: number;
  // other fields exist; we ignore for table
}

interface PnlRecord {
  height: number;
  contractId: number;
  accountingPNL: number;
  isBuyer: boolean;
  address: string;
  amount: number;
  tradePrice: number;
  collateralPropertyId: number;
  txid?: string;
  avgEntry?: number;
}

interface FuturesRow {
  block: number;
  side: 'Long' | 'Short' | '—';
  amount: number;
  price: number;
  fee?: number;
  txid?: string;
  pnl?: number;
  buyer: string;
  seller: string;
}

@Component({
  selector: 'tl-futures-trade-history',
  templateUrl: './futures-trade-history.component.html',
  styleUrls: ['../../../../spot-page/spot-trading-grid/spot-bottom-card/spot-trade-history/spot-trade-history.component.scss']
})
export class FuturesTradeHistoryComponent implements OnInit {
  displayedColumns: string[] = ['block', 'side', 'amount', 'price', 'fee', 'pnl', 'tx'];
  relayedHistory: FuturesRow[] = [];

  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private futuresMarketService: FuturesMarketService
  ) {}

  ngOnInit(): void {
    const market = this.futuresMarketService.selectedMarket;
    const contractId = Number(market?.contract_id ?? 0);
    const address = this.myAddress;

    if (!contractId || !address) {
      this.relayedHistory = [];
      return;
    }

    // 1) Load trade prints for this contract/address
    const params = new HttpParams()
      .set('contractId', String(contractId))
      .set('address', address);

    this.http.get<FuturesTradeRecord[]>('/tl_contractTradeHistoryForAddress', { params })
      .subscribe({
        next: (list) => {
          const rows = (list || []).map(tr => this.mapFuturesRow(tr, address));
          // Newest first
          this.relayedHistory = rows.sort((a, b) => (b.block ?? 0) - (a.block ?? 0));

          // 2) Try to load PNL prints and merge (optional; ignore failures)
          this.loadPnl(contractId, address);
        },
        error: () => {
          this.relayedHistory = [];
        }
      });
  }

  private loadPnl(contractId: number, address: string) {
    const params = new HttpParams()
      .set('contractId', String(contractId))
      .set('address', address);

    // If you don’t have this endpoint yet, this silently no-ops.
    this.http.get<PnlRecord[]>('/tl_contractPnlForAddress', { params })
      .subscribe({
        next: (pnls) => {
          if (!Array.isArray(pnls) || !pnls.length) return;
          // Attach PNL to closest-block matches (simple heuristic)
          for (const p of pnls) {
            const i = this.relayedHistory.findIndex(r => Math.abs((r.block ?? 0) - (p.height ?? 0)) <= 1);
            if (i >= 0) this.relayedHistory[i].pnl = p.accountingPNL;
          }
          this.relayedHistory = [...this.relayedHistory];
        },
        error: () => {}
      });
  }

  private mapFuturesRow(tr: FuturesTradeRecord, myAddr: string): FuturesRow {
    const youAreBuyer = this.eqAddr(myAddr, tr.buyerAddress);
    const youAreSeller = this.eqAddr(myAddr, tr.sellerAddress);

    // BuyerPosition / SellerPosition may be boolean or string
    const buyerLong = typeof tr.buyerPosition === 'string'
      ? tr.buyerPosition.toLowerCase() === 'long'
      : !!tr.buyerPosition;
    const sellerLong = typeof tr.sellerPosition === 'string'
      ? tr.sellerPosition.toLowerCase() === 'long'
      : !!tr.sellerPosition;

    let side: FuturesRow['side'] = '—';
    if (youAreBuyer) side = buyerLong ? 'Long' : 'Short';
    else if (youAreSeller) side = sellerLong ? 'Long' : 'Short';

    const fee = youAreBuyer ? tr.buyerFee : youAreSeller ? tr.sellerFee : undefined;
    const txid = youAreBuyer ? tr.buyerTx : youAreSeller ? tr.sellerTx : undefined;

    return {
      block: tr.block,
      side,
      amount: tr.amount,
      price: tr.price,
      fee,
      txid,
      buyer: tr.buyerAddress,
      seller: tr.sellerAddress
    };
  }

  shortTx(tx?: string): string {
    if (!tx) return '';
    return tx.length > 12 ? `${tx.slice(0, 6)}…${tx.slice(-6)}` : tx;
  }

  txUrl(row: FuturesRow): string | null {
    if (!row.txid) return null;
    const testnet = (row.buyer || '').startsWith('tltc') || (row.seller || '').startsWith('tltc');
    const chain = testnet ? 'LTCTEST' : 'LTC';
    return `https://chain.so/tx/${chain}/${row.txid}`;
  }

  private eqAddr(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    return a.toLowerCase() === b.toLowerCase();
  }

  private get myAddress(): string {
    const wa = (this.authService as any)?.walletAddresses || [];
    const first = wa[0];
    if (!first) return '';
    if (typeof first === 'string') return first;
    return first.address || '';
  }
}
