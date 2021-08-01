import { Injectable } from "@angular/core";
import { Subject } from "rxjs";
import { MarketsService } from "./markets.service";
import { SocketService } from "./socket.service";

export interface IOrderbook {
    amount: number,
    price: number,
    propIdDesired: number,
    propIdForSale: number,
}

@Injectable({
    providedIn: 'root',
})

export class OrderbookService {
    private _rawOrderbookData: IOrderbook[] = [];
    outsidePriceHandler: Subject<number> = new Subject();
    buyOrderbooks: { amount: number, price: number }[] = [];
    sellOrderbooks: { amount: number, price: number }[] = [];

    constructor(
        private socketService: SocketService,
        private markertService: MarketsService,
    ) {}

    get selectedMarket() {
        return this.markertService.selectedMarket;
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
        this.socket.on('orderbook-data', (orderbookData: IOrderbook[]) => {
            this.rawOrderbookData = orderbookData;
        });
        this.socket.on('aksfor-orderbook-update', () => {
            this.socket.emit('update-orderbook');
        });
        this.socket.emit('update-orderbook');
    }

    endOrderbookSbuscription() {
        this.socket.off('orderbook-data');
        this.socket.off('aksfor-orderbook-update');
    }

    private structureOrderBook() {
        this.buyOrderbooks = this._structureOrderbook(true);
        this.sellOrderbooks = this._structureOrderbook(false);
    }

    private _structureOrderbook(isBuy: boolean) {
        const propIdDesired = isBuy ? this.selectedMarket.first_token.propertyId : this.selectedMarket.second_token.propertyId;
        const propIdForSale = isBuy ? this.selectedMarket.second_token.propertyId : this.selectedMarket.first_token.propertyId;
        const filteredOrderbook = this.rawOrderbookData.filter(o => o.propIdDesired === propIdDesired && o.propIdForSale === propIdForSale);
        const range = 100;
        const result: {price: number, amount: number}[] = [];
        filteredOrderbook.forEach(o => {
          const _price = Math.trunc(o.price*range)
          const existing = result.find(_o =>  Math.trunc(_o.price*range) === _price);
          existing
            ? existing.amount += o.amount
            : result.push({
                price: parseFloat(o.price.toFixed(2)),
                amount: o.amount,
            });
        });
        return isBuy 
         ? result.sort((a, b) => b.price - a.price).slice(Math.max(result.length - 9, 0))
         : result.sort((a, b) => b.price - a.price).slice(0, 9);
    }
}
