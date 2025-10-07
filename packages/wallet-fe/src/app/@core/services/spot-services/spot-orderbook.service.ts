import { Injectable } from "@angular/core";
import { Subject } from "rxjs";
import { SpotMarketsService, IMarket  } from "./spot-markets.service";
import { obEventPrefix, SocketService } from "../socket.service";
import { ToastrService } from "ngx-toastr";
import { LoadingService } from "../loading.service";
import { AuthService } from "../auth.service";
import { ITradeInfo } from "src/app/utils/swapper";
import { ISpotTradeProps } from "src/app/utils/swapper/common";
type Side = 'bids' | 'asks' | 'both';

interface ISpotOrderbookData {
    orders: ISpotOrder[],
    history: ISpotHistoryTrade[],
}

export interface ISpotHistoryTrade extends ITradeInfo<ISpotTradeProps> {
    txid: string;
    side?: "SELL" | "BUY";
}

export interface ISpotOrder {
    action: "SELL" | "BUY",
    keypair: {
        address: string;
        pubkey: string;
    },
    lock: boolean;
    props: {
        amount: number;
        id_desired: number,
        id_for_sale: number;
        price: number;
    };
    socket_id: string;
    timestamp: number;
    type: "SPOT";
    uuid: string;
    state?: "CANCELED" | "FILLED"
}

@Injectable({
    providedIn: 'root',
})

export class SpotOrderbookService {
    private _rawOrderbookData: ISpotOrder[] = [];
    outsidePriceHandler: Subject<number> = new Subject();
    buyOrderbooks: { amount: number, price: number }[] = [];
    sellOrderbooks: { amount: number, price: number }[] = [];
    tradeHistory: ISpotHistoryTrade[] = [];
    currentPrice: number = 1;
    lastPrice: number = 1;
    private activeKey: string | null = null;
    private _lastRequestedKey: string | null = null;
    onUpdate?: () => void;

    constructor(
        private socketService: SocketService,
        private spotMarkertService: SpotMarketsService,
        private toastrService: ToastrService,
        private loadingService: LoadingService,
        private authService: AuthService,
    ) {}

    get activeSpotKey() {
        return this.authService.activeSpotKey;
    }

    get activeSpotAddress() {
        return this.activeSpotKey?.address;
    }

    get selectedMarket() {
        return this.spotMarkertService.selectedMarket;
    }

    get rawOrderbookData() {
        return this._rawOrderbookData;
    }

    get relatedHistoryTrades() {
        if (!this.activeSpotAddress) return [];
        return this.tradeHistory
            .filter(e => e.seller.keypair.address === this.activeSpotAddress || e.buyer.keypair.address === this.activeSpotAddress)
            .map(t => ({...t, side: t.buyer.keypair.address === this.activeSpotAddress ? 'BUY' : 'SELL'})) as ISpotHistoryTrade[];
    }

    set rawOrderbookData(value: ISpotOrder[]) {
        this._rawOrderbookData = value;
        this.structureOrderBook();
    } 

    private get socket() {
        return this.socketService.socket;
    }

    get marketFilter() {
        return this.spotMarkertService.marketFilter;
    };

    subscribeForOrderbook() {
        this.endOrderbookSbuscription();
        this.socket.on(`${obEventPrefix}::order:error`, (message: string) => {
            this.toastrService.error(message || `Undefined Error`, 'Orderbook Error');
            this.loadingService.tradesLoading = false;
        });

        this.socket.on(`${obEventPrefix}::disconnect`, () => {
            // Clear ALL local orderbook state
            this._rawOrderbookData = [];
            this.structureOrderBook();
            // Optionally: notify the user
            this.toastrService.info('Disconnected from orderbook server. Orders cleared.');
        });

        this.socket.on(`${obEventPrefix}::order:saved`, (data: any) => {
            this.loadingService.tradesLoading = false;
            this.toastrService.success(`The Order is Saved in Orderbook`, "Success");
        });

        this.socket.on(`${obEventPrefix}::update-orders-request`, () => {
            this.socket.emit('update-orderbook', this.marketFilter)
        });     

        this.socket.on(`${obEventPrefix}::orderbook-data`, (orderbookData: any) => {
          console.log('[Spot OB] update ' + JSON.stringify(orderbookData));
          const ts = Date.now();
          console.log(`[OB tick start ${ts}]`, {
          orders: orderbookData?.orders?.length ?? 0,
          isDelta: orderbookData?.isDelta ?? false,
          history: orderbookData?.history?.length ?? 0
        });

          const mk = orderbookData?.marketKey || this.activeKey;
          if (mk && this.activeKey && mk !== this.activeKey) return;
          if (Array.isArray(orderbookData.orders)) {
            if (orderbookData.isDelta) {
              this.rawOrderbookData = this.mergeOrders(
                this.rawOrderbookData,
                orderbookData.orders as ISpotOrder[]
              );
            } else {
              this.rawOrderbookData = orderbookData.orders as ISpotOrder[];
            }
          }

          this.tradeHistory = orderbookData.history || [];
          const lastTrade = this.tradeHistory[0];

          if (!lastTrade) {
            this.currentPrice = 1;
          } else {
            const { amountForSale, amountDesired } = lastTrade.props;
            this.currentPrice =
              parseFloat((amountForSale / amountDesired).toFixed(6)) || 1;
          }

          console.log(`[OB after structure] ${Date.now() - ts}ms`);
          this.onUpdate?.();
        });
    }

    endOrderbookSbuscription() {
        ['update-orders-request', 'orderbook-data', 'order:error', 'order:saved']
            .forEach(m => this.socket.off(`${obEventPrefix}::${m}`));
    }

    private structureOrderBook() {
        this.buyOrderbooks = this._structureOrderbook(true);
        this.sellOrderbooks = this._structureOrderbook(false);
    }

    private _structureOrderbook(isBuy: boolean) {

        const baseId  = this.selectedMarket.first_token.propertyId;   // normalized: base < quote
        const quoteId = this.selectedMarket.second_token.propertyId;
        const myKey   = this.normalizeKey(baseId, quoteId);

        // BUY: for_sale === baseId;  SELL: for_sale === quoteId
        const filteredOrderbook = (this.rawOrderbookData || []).filter(o =>
          this.normalizeKey(o?.props?.id_for_sale, o?.props?.id_desired) === myKey &&
          (isBuy ? o?.props?.id_for_sale === quoteId : o?.props?.id_for_sale === baseId)
        );

        const range = 1000;
        const result: {price: number, amount: number}[] = [];
        filteredOrderbook.forEach(o => {
          const _price = Math.trunc(o.props.price*range)
          const existing = result.find(_o =>  Math.trunc(_o.price*range) === _price);
          existing
            ? existing.amount += o.props.amount
            : result.push({
                price: parseFloat(o.props.price.toFixed(4)),
                amount: o.props.amount,
            });
        });
        if (!isBuy) this.lastPrice = result.sort((a, b) => b.price - a.price)?.[result.length - 1]?.price || this.currentPrice || 1;

        return isBuy
            ? result.sort((a, b) => b.price - a.price).slice(0, 9)
            : result.sort((a, b) => b.price - a.price).slice(Math.max(result.length - 9, 0));
    }

    private mergeOrders(current: ISpotOrder[], deltas: ISpotOrder[]): ISpotOrder[] {
      const map = new Map(current.map(o => [o.uuid, o]));
   
      for (const d of deltas) {
       d.props.amount = d.props.amount
        if (d.props.amount === 0 || d.state === "CANCELED") {
          map.delete(d.uuid); // remove if canceled
        } else {
          map.set(d.uuid, d); // upsert
        }
      }

      return Array.from(map.values());
    }
    
    /** Normalize spot keys using p1<p2 rule */
      private normalizeKey(p1: number, p2: number): string {
        return p1 < p2 ? `${p1}-${p2}` : `${p2}-${p1}`;
      }

      async switchMarket(
        first_token:number, second_token:number,
        p?: { depth?: number; side?: 'bids' | 'asks' | 'both'; includeTrades?: boolean }
      ) {
        const newKey = this.normalizeKey(first_token,second_token);

        // Leave old
        if (this.activeKey && this.activeKey !== newKey) {
          this.socket.send(JSON.stringify({ event: 'orderbook:leave', marketKey: this.activeKey }));
        }

        this.activeKey = newKey;
        this._lastRequestedKey = newKey;

        // Ask server for snapshot
        this.socket.send(
          JSON.stringify({
            event: 'update-orderbook',
            filter: {
              type: 'SPOT',
              first_token,
              second_token,
              depth: String(p?.depth ?? 50),
              side: p?.side ?? 'both',
              includeTrades: String(p?.includeTrades ?? false),
            },
          })
        );

        // Join for live deltas
        this.socket.send(JSON.stringify({ event: 'orderbook:join', marketKey: newKey }));
      }
}
