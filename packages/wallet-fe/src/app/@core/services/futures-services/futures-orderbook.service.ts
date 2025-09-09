import { Injectable } from "@angular/core";
import { Subject } from "rxjs";
import { obEventPrefix, SocketService } from "../socket.service";
import { ToastrService } from "ngx-toastr";
import { LoadingService } from "../loading.service";
import { AuthService } from "../auth.service";
import { FuturesMarketService, IFutureMarket } from "./futures-markets.service";
import { ITradeInfo } from "src/app/utils/swapper";
import { IFuturesTradeProps } from "src/app/utils/swapper/common";
import { BehaviorSubject } from 'rxjs';


type Side = 'bids' | 'asks' | 'both';

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
    lastPrice: number = 1;
    private _lastRequestedKey: string | null = null;

    constructor(
        private socketService: SocketService,
        private futuresMarketService: FuturesMarketService,
        private toastrService: ToastrService,
        private loadingService: LoadingService,
        private authService: AuthService,
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
        this.socket.send(
          JSON.stringify({ event: 'orderbook:leave', marketKey: this.activeKey })
        );
      }
      this.activeKey = newKey;
      this._lastRequestedKey = newKey;

      // 1. Ask server for a fresh snapshot (WS)
      this.socket.send(
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
      this.socket.send(
        JSON.stringify({ event: 'orderbook:join', marketKey: newKey })
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
        const mk = orderbookData?.marketKey ?? this._lastRequestedKey;
        //if (mk && this._activeKey && mk !== this._activeKey) return; // guard to active

  // Sometimes a bad server reply sends [{event:"new-order",…}] instead of a snapshot.
console.log('ob data in FE '+JSON.stringify(orderbookData.orders))

  if (!orderbookData || !Array.isArray(orderbookData.orders)) return;
  if (orderbookData.orders[0] && (orderbookData.orders[0] as any).event) {
    console.warn('[OB] Ignoring event-echo payload, waiting for snapshot');
    return;
  }
  this.rawOrderbookData = orderbookData.orders;
   this.tradeHistory   = orderbookData.history;
   const lastTrade = this.tradeHistory[0];
   if (!lastTrade) return this.currentPrice = 1;
   this.currentPrice = lastTrade?.props?.price || 1;
   return;
 });

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
