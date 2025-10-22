import { Subject } from "rxjs";
import { obEventPrefix, SocketService } from "../socket.service";
import { ToastrService } from "ngx-toastr";
import { LoadingService } from "../loading.service";
import { AuthService } from "../auth.service";
import { FuturesMarketService, IFutureMarket } from "./futures-markets.service";
import { ITradeInfo } from "src/app/utils/swapper";
import { IFuturesTradeProps } from "src/app/utils/swapper/common";
import { BehaviorSubject } from 'rxjs';
import { wrangleFuturesObMessageInPlace } from 'src/app/@core/utils/ob-normalize';
import { Injectable, NgZone } from "@angular/core";

type Side = 'bids' | 'asks' | 'both';

const s = (v: any) => { try { return JSON.stringify(v); } catch { return String(v); } };

interface IFuturesOrderbookData {
    orders: IFuturesOrder[],
    history: IFuturesHistoryTrade[],
};

export interface IFuturesHistoryTrade extends ITradeInfo<IFuturesTradeProps> {
    txid: string;
    side?: "SELL" | "BUY";
};

export interface IFuturesOrder {
    action: "SELL" | "BUY",
    keypair: {
        address: string;
        pubkey: string;
    },
    lock: boolean;
    props: {
        amount: number;
        contract_id: number;
        price: number;
        leverage: 10;
        collateral: number;
    };
    socket_id: string;
    timestamp: number;
    type: "FUTURES";
    uuid: string;
    state?: "CANCELED" | "FILLED";
}

@Injectable({
    providedIn: 'root',
})

export class FuturesOrderbookService {
    private activeKey: string | null = null;
    private books: Record<string, IFuturesOrderbookData> = {};
    private bound = false;
    private key(type: string, id: number|string) { return `${type}:${id}`; }
    private _rawOrderbookData: IFuturesOrder[] = [];
    outsidePriceHandler: Subject<number> = new Subject();
    buyOrderbooks$ = new BehaviorSubject<{ amount: number, price: number }[]>([]);
    sellOrderbooks$ = new BehaviorSubject<{ amount: number, price: number }[]>([]);
    tradeHistory: IFuturesHistoryTrade[] = [];
    currentPrice: number = 1;

    // === futures symbol edge-normalization (keep internal futures key numeric) ===
    private inboundToContractId(sym?: string | null): number | null {
      if (!sym || typeof sym !== 'string') return null;
      const m = sym.trim().match(/^([0-9]+)-perp$/i);
      return m ? Number(m[1]) : null;
    }
    private normalizeInboundKeyForFutures(msg: any): string | null {
      const mk: string | null = typeof msg?.marketKey === 'string' ? msg.marketKey : null;
      const sym: string | null = (msg?.orders && !Array.isArray(msg.orders) && typeof msg.orders.symbol === 'string')
        ? msg.orders.symbol
        : null;
      const inbound = mk ?? sym ?? null;
      if (!inbound) return null;
      const cid = this.inboundToContractId(inbound);
      return cid != null ? String(cid) : null;
    }
    private outboundMarketKeyForFutures(id: number | string): string {
      return `${id}-perp`;
    }
        lastPrice: number = 1;
    private _lastRequestedKey: string | null = null;
    onUpdate?: () => void;

    constructor(
        private socketService: SocketService,
        private futuresMarketService: FuturesMarketService,
        private toastrService: ToastrService,
        private loadingService: LoadingService,
        private authService: AuthService,
        private ngZone: NgZone, 
    ) {}

    get activeFuturesKey() {
        return this.authService.activeFuturesKey;
    }

    get activeFuturesAddress() {
        return this.activeFuturesKey?.address;
    }

    get selectedMarket() {
        return this.futuresMarketService.selectedMarket;
    }

    get rawOrderbookData() {
        return this._rawOrderbookData;
    }

    get relatedHistoryTrades() {
        if (!this.activeFuturesAddress) return [];
        return this.tradeHistory
            .filter(e => e.seller.keypair.address === this.activeFuturesAddress || e.buyer.keypair.address === this.activeFuturesAddress)
            .map(t => ({...t, side: t.buyer.keypair.address === this.activeFuturesAddress ? 'BUY' : 'SELL'})) as IFuturesHistoryTrade[];
    }

    set rawOrderbookData(value: IFuturesOrder[]) {
        this._rawOrderbookData = value;
        this.structureOrderBook();
    } 

    private get socket() {
        return this.socketService.socket;
    }

    get marketFilter() {
        return this.futuresMarketService.marketFilter;
    };

    /** FUTURES: if activeKey is unset, adopt it from the incoming OB message/service. */
    private ensureActiveFuturesKey(msg: any): void {
      if (this.activeKey) return;

      // Prefer explicit marketKey if present
      const mk =
        (typeof msg?.marketKey === 'string' && msg.marketKey.trim())
          ? msg.marketKey.trim()
          : null;

      // Or from a snapshot object: orders = { symbol: '...' } (before/after wrangler)
      const sym =
        (msg?.orders && !Array.isArray(msg.orders) && typeof msg.orders?.symbol === 'string')
          ? msg.orders.symbol.trim()
          : null;

      // Or from your markets service's selected market (if you have it on this service)
      const selSym: string | undefined =
        (this.futuresMarketService as any)?.selectedMarket?.symbol;

      this.activeKey = mk ?? sym ?? (selSym?.trim() ?? null);
    }


    private bindOnce() {
      if (this.bound) return; this.bound = true;
        this.socket.on('ORDERBOOK_DATA', (msg: any) => {
          if (!msg?.marketKey || msg.marketKey !== this.activeKey) return; // guard
          this.books[msg.marketKey] = { orders: msg.orders, history: msg.history };
        });
    }

    async switchMarket(
      type: 'FUTURES' | 'SPOT',
      contract_id: number,
      p?: { depth?: number; side?: 'bids' | 'asks' | 'both'; includeTrades?: boolean }
    ) {
      this.bindOnce();
      const newKey = this.key(type, contract_id);

      if (this.activeKey && this.activeKey !== newKey) {
        this.socket.emit(
          JSON.stringify({ event: 'orderbook:leave', marketKey: this.outboundMarketKeyForFutures(contract_id) })
        );
      }
      this.activeKey = newKey;
      this._lastRequestedKey = newKey;

      // 1. Ask server for a fresh snapshot (WS)
      this.socket.emit(
        JSON.stringify({
          event: 'update-orderbook',
          filter: {
            type,
            contract_id,
            depth: String(p?.depth ?? 50),
            side: p?.side ?? 'both',
            includeTrades: String(p?.includeTrades ?? false),
          },
        })
      );

      // 2. Join the market room for live deltas
      this.socket.emit(
        JSON.stringify({ event: 'orderbook:join', marketKey: this.outboundMarketKeyForFutures(contract_id) })
      );
    }

   getContractMeta(contract_id: number) {
        // Use FuturesMarketService.getMarketByContractId()
        const market = this.futuresMarketService.getMarketByContractId(contract_id);
        if (!market) return { contractSize: 1, isInverse: false };
        // Note: Derive contractSize, isInverse from your market model
        return {
            contractSize: market.notional || 1,           // <-- Use .notional for contract size
            isInverse: !!market.inverse                   // <-- Use .inverse for inverse contracts
        };
    }

    subscribeForOrderbook() {
        this.endOrderbookSubscription();

        this.socket.on(`${obEventPrefix}::connected`, (message: string) => {
            this.toastrService.success('Connected to orderbook server')
            const newKey = this.marketFilter.contract_id
            this.socket.emit('orderbook:join', { marketKey: this.outboundMarketKeyForFutures(this.marketFilter.contract_id) })
        });

        this.socket.on(`${obEventPrefix}::order:error`, (message: string) => {
            this.toastrService.error(message || `Undefined Error`, 'Orderbook Error');
            this.loadingService.tradesLoading = false;
        });

        this.socket.on(`${obEventPrefix}::order:saved`, (data: any) => {
            this.loadingService.tradesLoading = false;
            this.toastrService.success(`The Order is Saved in Orderbook`, "Success");
        });

        this.socket.on(`${obEventPrefix}::disconnect`, () => {
            // Clear ALL local orderbook state
            this._rawOrderbookData = [];
            console.log('cleared ob after disconnect '+JSON.stringify(this._rawOrderbookData))
            this.structureOrderBook();
            // Optionally: notify the user
            this.toastrService.info('Disconnected from orderbook server. Orders cleared.');
        });


        this.socket.on(`${obEventPrefix}::update-orders-request`, () => {
            this.socket.emit('update-orderbook', this.marketFilter)
        });

        console.log('[time]', Date.now(), 'set up listener for orderbook-data');
      this.socket.on(`${obEventPrefix}::orderbook-data`, (orderbookData: any) => {
        this.ngZone.run(() => {
          console.log('[Futures OB] update ' + JSON.stringify(orderbookData));

          // 1) Spot-style guard BEFORE wrangle (prevents wiping the book)
          if (Array.isArray(orderbookData.orders)) return;

          // 2) Wrangle snapshot -> array + normalize "*-perp" key
          orderbookData = wrangleFuturesObMessageInPlace(orderbookData);
          console.log('normalized futures book ' + JSON.stringify(orderbookData));

          const ts = Date.now();
          console.log(`[Futures OB tick start ${ts}] ` + JSON.stringify({
            orders: Array.isArray(orderbookData?.orders) ? orderbookData.orders.length : 0,
            isDelta: !!orderbookData?.isDelta,
            history: Array.isArray(orderbookData?.history) ? orderbookData.history.length : 0
          }));

          // 3) Active key gating — same as Spot
          const mk = orderbookData?.marketKey || this.activeKey;
          console.log('[Futures OB] active vs mk ' + JSON.stringify({ activeKey: this.activeKey, mk }));
          if (mk && this.activeKey && mk !== this.activeKey) return;

          // 4) Delta merge / overwrite — same as Spot
          if (orderbookData.isDelta) {
            this.rawOrderbookData = this.mergeOrders(
              this.rawOrderbookData,
              orderbookData.orders as IFuturesOrder[]
            );
          } else {
            this.rawOrderbookData = orderbookData.orders as IFuturesOrder[];
          }

          // 5) History + price — same pattern
          this.tradeHistory = orderbookData.history || [];
          const lastTrade = this.tradeHistory[0];
          this.currentPrice = (typeof lastTrade?.props?.price === 'number'
            ? lastTrade.props.price
            : this.rawOrderbookData?.[0]?.props?.price) || 1;

          console.log('[Futures OB after structure] ' + JSON.stringify({
            ms: Date.now() - ts, orders: this.rawOrderbookData?.length ?? 0, price: this.currentPrice
          }));

          this.onUpdate?.();
        });
      });
    }

    /**
     * Merge incoming futures orders into current snapshot.
     * Uses `uuid` (or txid if you prefer) as the unique key.
     */
    private mergeOrders(current: IFuturesOrder[], deltas: IFuturesOrder[]): IFuturesOrder[] {
      const map = new Map(current.map(o => [o.uuid, o]));

      for (const d of deltas) {
        if (d.props.amount === 0 || d.state === "CANCELED") {
          map.delete(d.uuid);
        } else {
          map.set(d.uuid, d);
        }
      }

      return Array.from(map.values());
    }

    endOrderbookSubscription() {
        ['update-orders-request', 'orderbook-data', 'order:error', 'order:saved']
            .forEach(m => this.socket.off(`${obEventPrefix}::${m}`));
    }

    private structureOrderBook() {
        console.log('structuring the book')
        this.buyOrderbooks$.next(this._structureOrderbook(true));
        this.sellOrderbooks$.next(this._structureOrderbook(false));
    }

    private _structureOrderbook(isBuy: boolean) {
         const contract_id = this.selectedMarket.contract_id;
      const { contractSize, isInverse } = this.getContractMeta(contract_id);

      const filteredOrderbook = this.rawOrderbookData.filter(
        (o) => o.props.contract_id === contract_id && o.action === (isBuy ? "BUY" : "SELL")
      );

      const range = 1000;
      const result: { price: number; amount: number }[] = [];

      filteredOrderbook.forEach((o) => {
        const _price = Math.trunc(o.props.price * range);

        // Convert amount to notional quote value
        const normalizedAmount = isInverse
          ? parseFloat((o.props.amount * o.props.price * contractSize).toFixed(8))
          : parseFloat((o.props.amount * contractSize).toFixed(8));

        const existing = result.find((_o) => Math.trunc(_o.price * range) === _price);
        if (existing) {
          existing.amount += normalizedAmount;
        } else {
          result.push({
            price: parseFloat(o.props.price.toFixed(4)),
            amount: normalizedAmount,
          });
        }
      });

      if (!isBuy) {
        this.lastPrice =
          result.sort((a, b) => b.price - a.price)?.[result.length - 1]?.price ||
          this.currentPrice ||
          1;
      }

      return isBuy
        ? result.sort((a, b) => b.price - a.price).slice(0, 9)
        : result.sort((a, b) => b.price - a.price).slice(Math.max(result.length - 9, 0));
    }

    switchFuturesMarket(contract_id: number, opts?: { depth?: number; side?:'bids'|'asks'|'both'; includeTrades?: boolean }) {
        return this.switchMarket('FUTURES', contract_id, opts);
    }

}
