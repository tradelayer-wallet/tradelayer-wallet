import { Injectable } from "@angular/core";
import { Subject } from "rxjs";
import { SpotMarketsService } from "./spot-markets.service";
import { obEventPrefix, SocketService } from "../socket.service";
import { ToastrService } from "ngx-toastr";
import { LoadingService } from "../loading.service";
import { AuthService } from "../auth.service";
import { ITradeInfo } from "src/app/utils/swapper";
import { ISpotTradeProps } from "src/app/utils/swapper/common";

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
        id_desired: number;
        id_for_sale: number;
        price: number;
    };
    socket_id: string;
    timestamp: number;
    type: "SPOT";
    uuid: string;
    state?: "CANCELLED" | "FILLED"
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

    constructor(
        private socketService: SocketService,
        private spotMarketService: SpotMarketsService,
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
        return this.spotMarketService.selectedMarket;
    }

    get rawOrderbookData() {
        return this._rawOrderbookData;
    }

    get relatedHistoryTrades() {
        if (!this.activeSpotAddress) return [];
        return this.tradeHistory
            .filter(e => e.seller.keypair.address === this.activeSpotAddress || e.buyer.keypair.address === this.activeSpotAddress)
            .map(t => ({ ...t, side: t.buyer.keypair.address === this.activeSpotAddress ? 'BUY' : 'SELL' })) as ISpotHistoryTrade[];
    }

    set rawOrderbookData(value: ISpotOrder[]) {
        this._rawOrderbookData = value;
        this.structureOrderBook();
    }

    private get socket() {
        return this.socketService.socket;
    }

    get marketFilter() {
        return this.spotMarketService.marketFilter;
    }

    subscribeForOrderbook() {
        this.endOrderbookSubscription();
        
        // Listen for 'order:error' event
        this.socket.addEventListener(`${obEventPrefix}::order:error`, (event: MessageEvent) => {
            const message = JSON.parse(event.data);
            this.toastrService.error(message || 'Undefined Error', 'Orderbook Error');
            this.loadingService.tradesLoading = false;
        });

        // Listen for 'order:saved' event
        this.socket.addEventListener(`${obEventPrefix}::order:saved`, (event: MessageEvent) => {
            const data = JSON.parse(event.data);
            this.loadingService.tradesLoading = false;
            this.toastrService.success(`The Order is Saved in Orderbook`, "Success");
        });

        // Listen for 'update-orders-request' event
        this.socket.addEventListener(`${obEventPrefix}::update-orders-request`, () => {
            this.socket.send('update-orderbook', this.marketFilter);
        });

        // Listen for 'orderbook-data' event
        this.socket.addEventListener(`${obEventPrefix}::orderbook-data`, (event: MessageEvent) => {
            const orderbookData: ISpotOrderbookData = JSON.parse(event.data);
            this.rawOrderbookData = orderbookData.orders;
            this.tradeHistory = orderbookData.history;
            const lastTrade = this.tradeHistory[0];
            if (!lastTrade) return this.currentPrice = 1;
            const { amountForSale, amountDesired } = lastTrade.props;
            const price = parseFloat((amountForSale / amountDesired).toFixed(6)) || 1;
            this.currentPrice = price;
            return;
        });

        // Emit 'update-orderbook' event
        this.socket.send('update-orderbook', this.marketFilter);
    }

    endOrderbookSubscription() {
        ['update-orders-request', 'orderbook-data', 'order:error', 'order:saved']
            .forEach(eventName => this.socket.removeEventListener(`${obEventPrefix}::${eventName}`));
    }

    private structureOrderBook() {
        this.buyOrderbooks = this._structureOrderbook(true);
        this.sellOrderbooks = this._structureOrderbook(false);
    }

    private _structureOrderbook(isBuy: boolean) {
        const propIdDesired = isBuy ? this.selectedMarket.first_token.propertyId : this.selectedMarket.second_token.propertyId;
        const propIdForSale = isBuy ? this.selectedMarket.second_token.propertyId : this.selectedMarket.first_token.propertyId;
        const filteredOrderbook = this.rawOrderbookData.filter(o => o.props.id_desired === propIdDesired && o.props.id_for_sale === propIdForSale);
        const range = 1000;
        const result: { price: number, amount: number }[] = [];
        filteredOrderbook.forEach(o => {
            const _price = Math.trunc(o.props.price * range);
            const existing = result.find(_o => Math.trunc(_o.price * range) === _price);
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
