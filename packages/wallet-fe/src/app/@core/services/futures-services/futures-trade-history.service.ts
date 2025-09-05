import { Injectable } from '@angular/core';
import axios, { AxiosResponse } from 'axios';
import { ApiService } from 'src/app/@core/services/api.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';

export interface FuturesTradeRow {
  block: number;
  side: 'BUY' | 'SELL' | string;
  baseAmount: number;
  price: number;
  totalQuote: number;
  yourRole: string;
  yourFee?: number;
  txid?: string;
  buyer?: string;
  seller?: string;
  // you can add other fields your template might use
}

@Injectable({ providedIn: 'root' })
export class FuturesTradeHistoryService {
  /** Bind your table directly to this */
  public rows: FuturesTradeRow[] = [];

  /** poll cadence (ms) */
  private refreshMs = 5000;

  /** interval handle */
  private timerId?: any;

  public baseURL: string = 'http://localhost:3000/';
  constructor(
    private api: ApiService,
    private auth: AuthService,
    private futMarkets: FuturesMarketService
  ) {
    this.start();

    // optional: refresh immediately on address or market change if you have streams
    this.auth.updateAddressesSubs$?.subscribe(() => this.refreshNow());
    (this.futMarkets as any).selectedMarket$?.subscribe?.(() => this.refreshNow());
    (this.futMarkets as any).marketChange$?.subscribe?.(() => this.refreshNow());
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

  /** try to extract ids from various possible shapes your futures market might use */
  private extractIdsFromMarket(m: any): { contractId?: number; collateralPropertyId?: number } {
    const cid =
      m?.contract_id

    const collat =
      m?.collateral?.propertyId

    return {
      contractId: cid !== undefined && cid !== null ? Number(cid) : undefined,
      collateralPropertyId: collat !== undefined && collat !== null ? Number(collat) : undefined,
    };
  }

  private async loadOnce(): Promise<void> {
  console.log('loading futures trade hist')
    try {
      const addr = this.auth.walletAddresses?.[0];
      const m = this.futMarkets.selectedMarket;
      const { contractId, collateralPropertyId } = this.extractIdsFromMarket(m);

      const hasAddr = !!addr;
      const hasCid = contractId !== undefined && contractId !== null && Number.isFinite(contractId);
      const hasColl = collateralPropertyId !== undefined && collateralPropertyId !== null && Number.isFinite(collateralPropertyId);


      console.log('query futures trades ', { addr, contractId, collateralPropertyId } );

      // NOTE: 0 can be a valid collateral (LTC). Don't treat 0 as missing.
      if (!(hasAddr && hasCid && hasColl)) {
        this.rows = [];
        return;
      }

      const uri = `${this.baseURL}tl_contractTradeHistoryForAddress`;


      const res: AxiosResponse<any> = await axios.get(uri, {
        params: {
          contractId,
          collateralPropertyId,
          address: addr,
        },
      });

      console.log('[futures-trade-history] '+JSON.stringify(res) );


      const payload = res.data?.result ?? res.data;
      const rawRows: any[] = Array.isArray(payload) ? payload : (payload?.rows ?? []);

      // normalize backend → UI
      const rows: FuturesTradeRow[] = rawRows.map((r: any) => {
        // Many backends expose buyer/seller for futures fills as well.
        // If yours uses "long/short" or "maker/taker" instead, tweak here.
        const side: 'BUY' | 'SELL' | string =
          r?.buyer && addr ? (r.buyer === addr ? 'BUY' : 'SELL') : (r?.side ?? '');

        const qty = Number(
          r?.amount ??
          r?.quantity ??
          r?.qty ??
          r?.baseAmount ??
          r?.size ??
          r?.contractAmount ??
          0
        );

        const price = Number(r?.price ?? r?.fillPrice ?? r?.tradePrice ?? 0);
        const baseAmount = Math.abs(qty);
        const totalQuote = baseAmount * price;

        return {
          block: Number(r?.block ?? r?.height ?? 0),
          side,
          baseAmount,
          price,
          totalQuote,
          yourRole: side,                 // mirrors spot; adjust if you show "Maker/Taker" instead
          yourFee: Number(r?.takerFee ?? r?.fee ?? 0),
          txid: r?.txid ?? r?._id ?? '',
          buyer: r?.buyer,
          seller: r?.seller,
        };
      });

      // new array ref so MatTable change detection triggers
      this.rows = rows.slice();
    } catch (err) {
      console.error('[futures-trade-history] load error:', err);
      this.rows = [];
    }
  }
}
