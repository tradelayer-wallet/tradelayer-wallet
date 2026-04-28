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
  counterparty?: string;
  // UI aliases
  amount?: number;
  total?: number;
  role?: string;
  fee?: number;
  tx?: string;
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
  private isLoading = false;

  public baseURL: string = 'http://localhost:3000/';
  constructor(
    private api: ApiService,
    private auth: AuthService,
    private futMarkets: FuturesMarketService
  ) {
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
    if (this.isLoading) return;
    this.isLoading = true;
    try {
      const addr = this.auth.walletAddresses?.[0];
      const m = this.futMarkets.selectedMarket;
      const { contractId, collateralPropertyId } = this.extractIdsFromMarket(m);

      const hasAddr = !!addr;
      const hasCid = contractId !== undefined && contractId !== null && Number.isFinite(contractId);
      const hasColl = collateralPropertyId !== undefined && collateralPropertyId !== null && Number.isFinite(collateralPropertyId);

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
      const payload = res.data?.result ?? res.data;
      const rawRows: any[] = Array.isArray(payload) ? payload : (payload?.rows ?? []);

      // normalize backend → UI
      const rows: FuturesTradeRow[] = rawRows.map((r: any) => {
        const addrL = String(addr || '').toLowerCase();

        const buyerAddr = String(
          r?.buyerAddress ??
          r?.buyer ??
          r?.trade?.buyerAddress ??
          r?.trade?.buyer ??
          ''
        );

        const sellerAddr = String(
          r?.sellerAddress ??
          r?.seller ??
          r?.trade?.sellerAddress ??
          r?.trade?.seller ??
          ''
        );

        const isBuyer = buyerAddr.toLowerCase() === addrL;
        const isSeller = sellerAddr.toLowerCase() === addrL;

        const rawSide = r?.side ?? r?.trade?.side;
        const side =
          isBuyer ? 'BUY' :
          isSeller ? 'SELL' :
          rawSide === 1 || rawSide === 'buy' ? 'BUY' :
          rawSide === 2 || rawSide === 'sell' ? 'SELL' :
          String(rawSide ?? '');

        const qty = Number(
          r?.amount ??
          r?.trade?.amount ??
          r?.quantity ??
          r?.qty ??
          r?.baseAmount ??
          r?.size ??
          r?.contractAmount ??
          0
        );

        const price = Number(
          r?.price ??
          r?.trade?.price ??
          r?.fillPrice ??
          r?.tradePrice ??
          0
        );
        const baseAmount = Math.abs(qty);
        const totalQuote = baseAmount * price;

        let yourRole = '';

        const buyerFee = Number(r?.trade?.buyerFee ?? 0);
        const sellerFee = Number(r?.trade?.sellerFee ?? 0);

        if (buyerFee === sellerFee) {
          yourRole = 'Split';
        } else if (isBuyer) {
          yourRole = buyerFee > sellerFee ? 'Taker' : 'Maker';
        } else if (isSeller) {
          yourRole = sellerFee > buyerFee ? 'Taker' : 'Maker';
        }

        const yourFee = Number(
          isBuyer ? r?.trade?.buyerFee :
          isSeller ? r?.trade?.sellerFee :
          0
        );

        const txid = String(
          (isBuyer ? r?.buyerTx ?? r?.trade?.buyerTx : undefined) ??
          (isSeller ? r?.sellerTx ?? r?.trade?.sellerTx : undefined) ??
          r?.txid ??
          r?.trade?.txid ??
          r?._id ??
          ''
        );

        const counterparty = String(
          isBuyer ? sellerAddr :
          isSeller ? buyerAddr :
          r?.counterparty ??
          r?.trade?.counterparty ??
          ''
        );

        return {
          block: Number(
            r?.block ??
            r?.blockHeight ??
            r?.height ??
            r?.trade?.block ??
            r?.trade?.blockHeight ??
            0
          ),
          side,
          baseAmount,
          price,
          totalQuote,
          yourRole,
          yourFee,
          txid,
          counterparty,
          amount: baseAmount,
          total: totalQuote,
          role: yourRole,
          fee: yourFee,
          tx: txid,
          buyer: buyerAddr || r?.buyer,
          seller: sellerAddr || r?.seller,
        };
      });

      // new array ref so MatTable change detection triggers
      this.rows = rows.slice();
    } catch (err) {
      console.error('[futures-trade-history] load error:', err);
      this.rows = [];
    } finally {
      this.isLoading = false;
    }
  }
}
