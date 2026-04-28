import { Injectable } from '@angular/core';
import { ApiService } from 'src/app/@core/services/api.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';
import axios from 'axios'

export interface SpotTradeRecord {
  txid: string;
  // add other fields you render (timestamp, side, price, amount, etc.)
  [k: string]: any;
}

@Injectable({ providedIn: 'root' })
export class SpotTradeHistoryService {
  /** Latest rows for UI binding (bind your table directly to this) */
  public rows: SpotTradeRecord[] = [];
  public baseURL: string = 'http://localhost:3000/';
  /** poll cadence (ms) */
  private refreshMs = 5000;

  /** interval handle */
  private timerId?: any;
  private isLoading = false;

  constructor(
    private apiService: ApiService,
    private authService: AuthService,
    private spotMarkets: SpotMarketsService
  ) {}

  /** Convenience accessor (matches your pattern) */
  get tlApi() {
    return this.apiService.newTlApi;
  }

  /** Start (or restart) polling */
  start(): void {
    this.stop();
    this.loadOnce(); // run immediately
    this.timerId = setInterval(() => this.loadOnce(), this.refreshMs);
  }

  /** Stop polling */
  stop(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = undefined;
    }
  }

  /** Change cadence at runtime */
  setRefreshMs(ms: number): void {
    this.refreshMs = Math.max(1000, ms | 0);
    this.start();
  }

  /** Manual immediate refresh */
  refreshNow(): void {
    this.loadOnce();
  }

  // ---------- internals ----------
  private async loadOnce(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;
    try {
      const addr = this.authService.walletAddresses?.[0];
      const m = this.spotMarkets.selectedMarket;

      const p1raw = m?.first_token?.propertyId;
      const p2raw = m?.second_token?.propertyId;

      const hasAddr = !!addr;
      const hasP1 = p1raw !== undefined && p1raw !== null;
      const hasP2 = p2raw !== undefined && p2raw !== null;

      const p1 = hasP1 ? Number(p1raw) : NaN;
      const p2 = hasP2 ? Number(p2raw) : NaN;

      if (!(hasAddr && Number.isFinite(p1) && Number.isFinite(p2))) {
        this.rows = [];
        return; // ok to return here since no lock held
      }

      const uri = this.baseURL+'tl_tokenTradeHistoryForAddress'
      
      const res = await axios.get(uri, {
        params: {
          propertyId1: p1,
          propertyId2: p2,
          address: addr,
        },
      });

     const payload = (res.data && res.data.result !== undefined) ? res.data.result: res.data;
      const rawRows = Array.isArray(payload) ? payload : (payload?.rows ?? []);

      // normalize backend → UI
      const rows = rawRows.map((r: any) => {
        const side = r.buyer === addr ? 'BUY' : 'SELL';
        const baseAmount =
          side === 'BUY'
            ? r.amountOffered
            : (r.amountExpected ?? 0);

        return {
          block: r.block,
          side,
          baseAmount,
          price: r.price,
          totalQuote: baseAmount * r.price,
          yourRole: side,
          yourFee: r.takerFee,
          txid: r.txid ?? '',
          buyer: r.buyer,
          seller: r.seller,
        };
      });

      this.rows = rows.slice(); // new ref so MatTable updates
    } catch (err) {
      console.error('[spot-trade-history] load error:', err);
      this.rows = [];
    } finally {
      this.isLoading = false;
    }
  }
}
