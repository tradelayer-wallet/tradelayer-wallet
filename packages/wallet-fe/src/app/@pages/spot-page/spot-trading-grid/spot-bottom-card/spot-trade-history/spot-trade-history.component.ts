import { Component, OnInit } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { AuthService } from 'src/app/@core/services/auth.service';
import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';

type MakerTaker = 'maker' | 'taker' | 'unknown';

interface SpotTradeRecord {
  offeredPropertyId: number;
  desiredPropertyId: number;
  amountOffered: number;
  amountExpected: number;
  price: number;
  buyerRole: MakerTaker;
  sellerRole: MakerTaker;
  takerFee: number;
  makerFee: number;
  block: number;
  buyer: string;
  seller: string;
  takerTxId?: string;
}

interface SpotRow {
  block: number;
  time?: string;
  side: 'BUY' | 'SELL' | 'N/A';
  baseAmount: number;
  price: number;
  totalQuote: number;
  yourRole: MakerTaker;
  yourFee?: number;
  txid?: string;
  buyer: string;
  seller: string;
}

@Component({
  selector: 'tl-spot-trade-history',
  templateUrl: './spot-trade-history.component.html',
  styleUrls: ['./spot-trade-history.component.scss']
})
export class SpotTradeHistoryComponent implements OnInit {
  displayedColumns: string[] = [
    'block', 'side', 'amount', 'price', 'total', 'role', 'fee', 'tx', 'counterparty'
  ];
  relayedHistory: SpotRow[] = [];

  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private spotMarketService: SpotMarketsService
  ) {}

  ngOnInit(): void {
    // Pull current pair from market service
    const m = this.spotMarketService.selectedMarket;
    // Expected structure: m.first_token.propertyId & m.second_token.propertyId
    const propertyId1 = Number(m?.first_token?.propertyId ?? 0);
    const propertyId2 = Number(m?.second_token?.propertyId ?? 0);

    const address = this.myAddress;

    if (!propertyId1 || !propertyId2 || !address) {
      this.relayedHistory = [];
      return;
    }

    const params = new HttpParams()
      .set('propertyId1', String(propertyId1))
      .set('propertyId2', String(propertyId2))
      .set('address', address);

    this.http.get<SpotTradeRecord[]>('/tl_tokenTradeHistoryForAddress', { params })
      .subscribe({
        next: (list) => {
          const rows = (list || []).map(tr => this.mapSpotRow(tr, propertyId1, propertyId2, address));
          // newest first by block (if equal, leave order)
          this.relayedHistory = rows.sort((a, b) => (b.block ?? 0) - (a.block ?? 0));
        },
        error: () => {
          this.relayedHistory = [];
        }
      });
  }

  // Gracefully handle if walletAddresses is string[] or {address:string}[]
  private get myAddress(): string {
    const wa = (this.authService as any)?.walletAddresses || [];
    const first = wa[0];
    if (!first) return '';
    if (typeof first === 'string') return first;
    return first.address || '';
  }

  private mapSpotRow(
    tr: SpotTradeRecord,
    pid1: number,
    pid2: number,
    myAddr: string
  ): SpotRow {
    // Decide which amount is the "base" (pid1)
    const baseAmount = tr.offeredPropertyId === pid1 ? tr.amountOffered
                     : tr.desiredPropertyId === pid1 ? tr.amountExpected
                     : 0;
    const totalQuote = baseAmount * Number(tr.price || 0);

    const youAreBuyer = this.eqAddr(myAddr, tr.buyer);
    const youAreSeller = this.eqAddr(myAddr, tr.seller);

    const side: SpotRow['side'] =
      youAreBuyer ? 'BUY' : youAreSeller ? 'SELL' : 'N/A';

    // Maker/Taker from your perspective
    const yourRole: MakerTaker = youAreBuyer ? tr.buyerRole : youAreSeller ? tr.sellerRole : 'unknown';
    const yourFee = yourRole === 'maker' ? tr.makerFee
                   : yourRole === 'taker' ? tr.takerFee
                   : undefined;

    // txid is recorded as takerTxId (the fill)
    const txid = tr.takerTxId;

    return {
      block: tr.block,
      side,
      baseAmount,
      price: tr.price,
      totalQuote,
      yourRole,
      yourFee,
      txid,
      buyer: tr.buyer,
      seller: tr.seller
    };
  }

  shortTx(tx?: string): string {
    if (!tx) return '';
    return tx.length > 12 ? `${tx.slice(0, 6)}…${tx.slice(-6)}` : tx;
  }

  txUrl(row: SpotRow): string | null {
    if (!row.txid) return null;
    // Crude heuristic: if either party looks testnet (tltc…), use LTCTEST
    const useTestnet = (row.buyer || '').startsWith('tltc') || (row.seller || '').startsWith('tltc');
    const chain = useTestnet ? 'LTCTEST' : 'LTC';
    return `https://chain.so/tx/${chain}/${row.txid}`;
  }

  copy(value: string) {
    if (!value) return;
    navigator.clipboard?.writeText(value).catch(() => {});
  }

  private eqAddr(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    return a.toLowerCase() === b.toLowerCase();
  }
}
