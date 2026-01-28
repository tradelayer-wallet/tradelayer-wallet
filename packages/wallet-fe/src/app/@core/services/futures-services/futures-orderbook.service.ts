import { Subject, BehaviorSubject, Subscription } from "rxjs";
import { takeUntil, auditTime } from 'rxjs/operators';
import { obEventPrefix, SocketService } from "../socket.service";
import { ToastrService } from "ngx-toastr";
import { LoadingService } from "../loading.service";
import { AuthService } from "../auth.service";
import { FuturesMarketService, IFutureMarket } from "./futures-markets.service";
import { ITradeInfo } from "src/app/utils/swapper";
import { IFuturesTradeProps } from "src/app/utils/swapper/common";
import { wrangleFuturesObMessageInPlace } from 'src/app/@core/utils/ob-normalize';
import { Injectable, NgZone, OnDestroy } from "@angular/core";
import { RpcService } from "../rpc.service"

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
export class FuturesOrderbookService implements OnDestroy {
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

    // === NEW: Proper subscription management ===
    private destroy$ = new Subject<void>();
    private subscriptions: Subscription[] = [];
    private isSubscribed = false;

    // === NEW: Throttled update subject ===
    private updateTrigger$ = new Subject<void>();

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
        private rpcService: RpcService, 
        private ngZone: NgZone, 
    ) {
        // === NEW: Throttled updates at ~30fps max ===
        this.updateTrigger$.pipe(
            auditTime(32), // ~30fps max, prevents CD storms
            takeUntil(this.destroy$)
        ).subscribe(() => {
            this.onUpdate?.();
        });
    }

    ngOnDestroy() {
        this.destroy$.next();
        this.destroy$.complete();
        this.cleanupSubscriptions();
    }

    private cleanupSubscriptions() {
        this.subscriptions.forEach(s => s.unsubscribe());
        this.subscriptions = [];
    }

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
      const mk =
        (typeof msg?.marketKey === 'string' && msg.marketKey.trim())
          ? msg.marketKey.trim()
          : null;
      const sym =
        (msg?.orders && !Array.isArray(msg.orders) && typeof msg.orders?.symbol === 'string')
          ? msg.orders.symbol.trim()
          : null;
      const selSym: string | undefined =
        (this.futuresMarketService as any)?.selectedMarket?.symbol;
      this.activeKey = mk ?? sym ?? (selSym?.trim() ?? null);
    }

    private bindOnce() {
      if (this.bound) return; this.bound = true;
        this.socket.on('ORDERBOOK_DATA', (msg: any) => {
          if (!msg?.marketKey || msg.marketKey !== this.activeKey) return;
          this.books[msg.marketKey] = { orders: msg.orders, history: msg.history };
        });
    }

    async switchMarket(
	  type: 'FUTURES' | 'SPOT',
	  contract_id: number,
	  p?: { depth?: number; side?: 'bids' | 'asks' | 'both'; includeTrades?: boolean }
	) {
	  this.bindOnce();

	  const net = this.rpcService.NETWORK;

	  // IMPORTANT: futures activeKey must match inbound marketKey format
	  const newKey = this.outboundMarketKeyForFutures(contract_id); // "2-perp"

	  // leave old market (if any)
	  if (this.activeKey && this.activeKey !== newKey) {
	    this.socket.emit('orderbook:leave', { marketKey: this.activeKey, network: net });
	  }

	  // reset local state on switch (Spot behavior effectively does this via replacement)
	  this._rawOrderbookData = [];
	  this.tradeHistory = [];
	  this.currentPrice = 1;
	  this.structureOrderBook();

	  this.activeKey = newKey;
	  this._lastRequestedKey = newKey;

	  // request snapshot
	  this.socket.emit('update-orderbook', {
	    filter: {
	      type,
	      contract_id,
	      depth: String(p?.depth ?? 50),
	      side: p?.side ?? 'both',
	      includeTrades: String(p?.includeTrades ?? false),
	      network: net,
	    },
	  });

	  // join market stream
	  this.socket.emit('orderbook:join', { marketKey: newKey, network: net });
	}

   getContractMeta(contract_id: number) {
        const market = this.futuresMarketService.getMarketByContractId(contract_id);
        if (!market) return { contractSize: 1, isInverse: false };
        return {
            contractSize: market.notional || 1,
            isInverse: !!market.inverse
        };
    }

    subscribeForOrderbook() {
        this.endOrderbookSubscription();
        this.isSubscribed = true;

        // === FIX: Use socket service's shared streams where possible ===
        this.socket.on(`${obEventPrefix}::connected`, (message: string) => {
            this.toastrService.success('Connected to orderbook server')
            const newKey = this.marketFilter.contract_id
            const net = this.rpcService.NETWORK
            this.socket.emit('orderbook:join', { marketKey: this.outboundMarketKeyForFutures(this.marketFilter.contract_id), network: net })
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
            this._rawOrderbookData = [];
            console.log('cleared ob after disconnect '+JSON.stringify(this._rawOrderbookData))
            this.structureOrderBook();
            this.toastrService.info('Disconnected from orderbook server. Orders cleared.');
        });

        this.socket.on(`${obEventPrefix}::update-orders-request`, () => {
            const net = this.rpcService.NETWORK
            this.socket.emit('update-orderbook', { ...this.marketFilter, network: net })
        });

        console.log('[time]', Date.now(), 'set up listener for orderbook-data');
        this.socket.on(`${obEventPrefix}::orderbook-data`, (orderbookData: any) => {
            this.ngZone.run(() => {
                console.log('[Futures OB] update ' + JSON.stringify(orderbookData));

                orderbookData = wrangleFuturesObMessageInPlace(orderbookData);
                console.log('normalized futures book ' + JSON.stringify(orderbookData));
                this.ensureActiveFuturesKey(orderbookData);
                const ts = Date.now();
                console.log(`[Futures OB tick start ${ts}] ` + JSON.stringify({
                    orders: Array.isArray(orderbookData?.orders) ? orderbookData.orders.length : 0,
                    isDelta: !!orderbookData?.isDelta,
                    history: Array.isArray(orderbookData?.history) ? orderbookData.history.length : 0
                }));

                const mk = orderbookData?.marketKey || this.activeKey;
                console.log('[Futures OB] active vs mk ' + JSON.stringify({ activeKey: this.activeKey, mk }));
                if (mk && this.activeKey && mk !== this.activeKey) return;

                if (orderbookData.isDelta) {
                    this.rawOrderbookData = this.mergeOrders(
                        this.rawOrderbookData,
                        orderbookData.orders as IFuturesOrder[]
                    );
                } else {
                    this.rawOrderbookData = orderbookData.orders as IFuturesOrder[];
                }

                this.tradeHistory = orderbookData.history || [];
                const lastTrade = this.tradeHistory[0];
                this.currentPrice = (typeof lastTrade?.props?.price === 'number'
                    ? lastTrade.props.price
                    : this.rawOrderbookData?.[0]?.props?.price) || 1;

                console.log('[Futures OB after structure] ' + JSON.stringify({
                    ms: Date.now() - ts, orders: this.rawOrderbookData?.length ?? 0, price: this.currentPrice
                }));

                // === FIX: Throttled update trigger instead of direct onUpdate ===
                this.updateTrigger$.next();
            });
        });
    }

    /**
     * Merge incoming futures orders into current snapshot.
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
        // === FIX: Remove ALL listeners we added ===
        ['update-orders-request', 'orderbook-data', 'order:error', 'order:saved', 'connected', 'disconnect']
            .forEach(m => this.socket.off(`${obEventPrefix}::${m}`));
        this.isSubscribed = false;
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

        // === FIX: Slice to max 50 levels (already sliced to 9, but good practice) ===
        return isBuy
            ? result.sort((a, b) => b.price - a.price).slice(0, 9)
            : result.sort((a, b) => b.price - a.price).slice(Math.max(result.length - 9, 0));
    }

    switchFuturesMarket(contract_id: number, opts?: { depth?: number; side?:'bids'|'asks'|'both'; includeTrades?: boolean }) {
        return this.switchMarket('FUTURES', contract_id, opts);
    }
}
