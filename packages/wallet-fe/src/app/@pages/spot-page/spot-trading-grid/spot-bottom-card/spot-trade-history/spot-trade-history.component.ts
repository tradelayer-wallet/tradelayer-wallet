import { Component, OnInit } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { ToastrService } from 'ngx-toastr';

import { SpotMarketService } from 'src/app/@core/services/spot-services/spot-markets.service';
import { AuthService } from 'src/app/@core/services/auth.service';

type UiRow = {
  date?: string | number | Date | null;
  side: 'BUY' | 'SELL' | '-';
  buyer: string;
  seller: string;
  amount: number;
  price: number;
  total: number;
  txid?: string;
};

@Component({
  selector: 'tl-spot-trade-history',
  templateUrl: './spot-trade-history.component.html',
  styleUrls: ['./spot-trade-history.component.scss']
})
export class SpotTradeHistoryComponent implements OnInit {
  displayedColumns: string[] = ['date', 'side', 'buyer', 'seller', 'amount', 'price', 'total', 'txid'];
  private _rows: UiRow[] = [];

  constructor(
    private http: HttpClient,
    private spotMarketService: SpotMarketService,
    private authService: AuthService,
    private toastr: ToastrService,
  ) {}

  ngOnInit() {
    this.load();
  }

  private get spotAddress(): string {
    // align with spot buy/sell logic: selected-spot-address → selected-address → first wallet address
    const fromLS =
      localStorage.getItem('selected-spot-address') ||
      localStorage.getItem('selected-address') || '';
    if (fromLS) return fromLS;
    return this.authService.walletAddresses?.[0]?.address || '';
  }

  private get pids(): { propertyId1?: number; propertyId2?: number } {
    const m = this.spotMarketService.selectedMarket;
    return {
      propertyId1: m?.first_token?.propertyId,
      propertyId2: m?.second_token?.propertyId,
    };
  }

  private load() {
    const { propertyId1, propertyId2 } = this.pids;
    const address = this.spotAddress;

    if (!propertyId1 || !propertyId2 || !address) {
      this._rows = [];
      return;
    }

    const params = new HttpParams()
      .set('propertyId1', String(propertyId1))
      .set('propertyId2', String(propertyId2))
      .set('address', address);

    this.http.get<any[]>('/tl_tokenTradeHistoryForAddress', { params }).subscribe({
      next: (list: any[]) => {
        // trade record saved as:
        // { offeredPropertyId, desiredPropertyId, amountOffered, amountExpected,
        //   price, buyerRole, sellerRole, takerFee, makerFee, block, buyer, seller, txid? }
        this._rows = (list || []).map((t: any) => {
          const side: 'BUY' | 'SELL' | '-' =
            t?.buyer === address ? 'BUY' : (t?.seller === address ? 'SELL' : '-');

          return {
            date: t?.time || null,                 // show when you add timestamps; safe if null
            side,
            buyer: t?.buyer || '',
            seller: t?.seller || '',
            amount: Number(t?.amountOffered ?? 0),
            price: Number(t?.price ?? 0),
            total: Number(t?.amountExpected ?? 0),
            txid: t?.txid || ''
          } as UiRow;
        });
      },
      error: (err) => {
        this._rows = [];
        this.toastr.error(err?.message || 'Failed to load spot trade history');
      }
    });
  }

  // template datasource
  get relayedHistory(): UiRow[] {
    return this._rows;
  }

  copy(text: string) {
    if (!text) return;
    navigator.clipboard.writeText(text);
    this.toastr.info(`Transaction Id Copied to clipboard: ${text}`, 'Copied');
  }
}
