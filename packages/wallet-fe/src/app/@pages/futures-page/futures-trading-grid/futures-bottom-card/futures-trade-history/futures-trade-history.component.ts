import { Component, OnInit } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { ToastrService } from 'ngx-toastr';

import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';
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
  selector: 'tl-futures-trade-history',
  templateUrl: '../../../../spot-page/spot-trading-grid/spot-bottom-card/spot-trade-history/spot-trade-history.component.html',
  styleUrls: ['../../../../spot-page/spot-trading-grid/spot-bottom-card/spot-trade-history/spot-trade-history.component.scss']
})
export class FuturesTradeHistoryComponent implements OnInit {
  displayedColumns: string[] = ['date', 'side', 'buyer', 'seller', 'amount', 'price', 'total', 'txid'];
  private _rows: UiRow[] = [];

  constructor(
    private http: HttpClient,
    private futuresMarketService: FuturesMarketService,
    private authService: AuthService,
    private toastr: ToastrService,
  ) {}

  ngOnInit() {
    this.load();
  }

  private get futuresAddress(): string {
    // Mirrors futures buy/sell card selection logic
    return this.authService.walletAddresses?.[0]?.address || '';
  }

  private get contractId(): number | undefined {
    return this.futuresMarketService.selectedMarket?.contract_id;
  }

  private load() {
    const contractId = this.contractId;
    const address = this.futuresAddress;

    if (!contractId || !address) {
      this._rows = [];
      return;
    }

    const params = new HttpParams()
      .set('contractId', String(contractId))
      .set('address', address);

    this.http
      .get<any[]>('/tl_contractTradeHistoryForAddress', { params })
      .subscribe({
        next: (list: any[]) => {
          // trade record format (per your saver):
          // {
          //   offeredPropertyId, desiredPropertyId,
          //   amountOffered, amountExpected, price,
          //   buyerRole, sellerRole, takerFee, makerFee,
          //   block, buyer, seller,  (txid may or may not be on the object)
          // }
          this._rows = (list || []).map((t: any) => {
            const side: 'BUY' | 'SELL' | '-' =
              t?.buyer === address ? 'BUY' : (t?.seller === address ? 'SELL' : '-');

            return {
              // If you later add a timestamp, drop it here; the date pipe handles undefined/null gracefully.
              date: t?.time || null,
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
          this.toastr.error(err?.message || 'Failed to load futures trade history');
        }
      });
  }

  // Template reads this getter as the datasource
  get relayedHistory(): UiRow[] {
    return this._rows;
  }

  get selectedMarket() {
    return this.futuresMarketService.selectedMarket;
  }

  copy(text: string) {
    if (!text) return;
    navigator.clipboard.writeText(text);
    this.toastr.info(`Transaction Id Copied to clipboard: ${text}`, 'Copied');
  }
}
