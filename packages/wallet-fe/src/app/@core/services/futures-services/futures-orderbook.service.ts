import { Injectable } from "@angular/core";
import { Subject } from "rxjs";
import { obEventPrefix, SocketService } from "../socket.service";
import { ToastrService } from "ngx-toastr";
import { LoadingService } from "../loading.service";
import { AuthService } from "../auth.service";
import { FuturesMarketService } from "./futures-markets.service";
import { ITradeInfo } from "src/app/utils/swapper";
import { IFuturesTradeProps } from "src/app/utils/swapper/common";
import { BehaviorSubject } from 'rxjs';


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
    private _rawOrderbookData: IFuturesOrder[] = [];
    outsidePriceHandler: Subject<number> = new Subject();
buyOrderbooks$ = new BehaviorSubject<{ amount: number, price: number }[]>([]);
sellOrderbooks$ = new BehaviorSubject<{ amount: number, price: number }[]>([]);
    tradeHistory: IFuturesHistoryTrade[] = [];
    currentPrice: number = 1;
    lastPrice: number = 1;

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

        this.socket.on('disconnect', () => {
            // Clear ALL local orderbook state
            this._rawOrderbookData = [];
            this.structureOrderBook();
            // Optionally: notify the user
            this.toastrService.info('Disconnected from orderbook server. Orders cleared.');
        });


        this.socket.on(`${obEventPrefix}::update-orders-request`, () => {
            this.socket.emit('update-orderbook', this.marketFilter)
        });

             console.log('[time]', Date.now(), 'set up listener for orderbook-data');
        this.socket.on(`${obEventPrefix}::orderbook-data`, (orderbookData: IFuturesOrderbookData) => {
            console.log('ob data in FE '+JSON.stringify(orderbookData.orders))
            this.rawOrderbookData = orderbookData.orders;
            this.tradeHistory = orderbookData.history;
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
        const filteredOrderbook = this.rawOrderbookData.filter(o => o.props.contract_id === contract_id && o.action === (isBuy ? "BUY" : "SELL"));
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
}
