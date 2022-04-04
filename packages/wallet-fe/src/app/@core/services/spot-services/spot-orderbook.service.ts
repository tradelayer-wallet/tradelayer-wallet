import { Injectable } from "@angular/core";
import { Subject } from "rxjs";
import { SpotMarketsService } from "./spot-markets.service";
import { SocketService } from "../socket.service";

export interface IOrderbook {
    amount: number,
    price: number,
    propIdDesired: number,
    propIdForSale: number,
}

@Injectable({
    providedIn: 'root',
})

export class SpotOrderbookService {
    private _rawOrderbookData: IOrderbook[] = [];
    outsidePriceHandler: Subject<number> = new Subject();
    buyOrderbooks: { amount: number, price: number }[] = [];
    sellOrderbooks: { amount: number, price: number }[] = [];
    tradeHistory: any[] = [];

    constructor(
        private socketService: SocketService,
        private spotMarkertService: SpotMarketsService,
    ) {}

    get selectedMarket() {
        return this.spotMarkertService.selectedMarket;
    }

    get rawOrderbookData() {
        return this._rawOrderbookData;
    }

    set rawOrderbookData(value: IOrderbook[]) {
        this._rawOrderbookData = value;
        this.structureOrderBook();
    } 

    private get socket() {
        return this.socketService.socket;
    }

    subscribeForOrderbook() {
        this.endOrderbookSbuscription();
        
        this.socket.on('OBSERVER::update-request', () => {
            const filter = {};
            this.socket.emit('update', filter)
        });
        this.socket.on('OBSERVER::orderbook-data', (orderbookData: IOrderbook[]) => {
            this.rawOrderbookData = orderbookData;
        });

        this.socket.on('OBSERVER::trade-history', (tradesHistory: any) => {
            this.tradeHistory = tradesHistory;
        });

        this.socket.emit('update');
    }

    endOrderbookSbuscription() {
        ['update-request', 'orderbook-data', 'trade-history']
            .forEach(m => this.socket.off(`OBSERVER::${m}`));
    }

    private structureOrderBook() {
        this.buyOrderbooks = this._structureOrderbook(true);
        this.sellOrderbooks = this._structureOrderbook(false);
    }

    private _structureOrderbook(isBuy: boolean) {
        const propIdDesired = isBuy ? this.selectedMarket.first_token.propertyId : this.selectedMarket.second_token.propertyId;
        const propIdForSale = isBuy ? this.selectedMarket.second_token.propertyId : this.selectedMarket.first_token.propertyId;
        const filteredOrderbook = this.rawOrderbookData.filter(o => o.propIdDesired === propIdDesired && o.propIdForSale === propIdForSale);
        const range = 1000;
        const result: {price: number, amount: number}[] = [];
        filteredOrderbook.forEach(o => {
          const _price = Math.trunc(o.price*range)
          const existing = result.find(_o =>  Math.trunc(_o.price*range) === _price);
          existing
            ? existing.amount += o.amount
            : result.push({
                price: parseFloat(o.price.toFixed(4)),
                amount: o.amount,
            });
        });
        return isBuy
        ? result.sort((a, b) => b.price - a.price).slice(0, 9)
        : result.sort((a, b) => b.price - a.price).slice(Math.max(result.length - 9, 0));
    }
}
