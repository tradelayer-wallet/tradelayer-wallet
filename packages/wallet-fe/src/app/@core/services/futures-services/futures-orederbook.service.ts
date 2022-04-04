import { Injectable } from "@angular/core";
import { Subject } from "rxjs";
import { FuturesMarketsService } from "./futures-markets.service";
import { SocketService } from "../socket.service";

export interface IOrderbook {
    amount: number,
    price: number,
    contractId: number,
    isBuy: boolean,
}

@Injectable({
    providedIn: 'root',
})

export class FuturesOrderbookService {
    private _rawOrderbookData: IOrderbook[] = [];
    outsidePriceHandler: Subject<number> = new Subject();
    buyOrderbooks: { amount: number, price: number }[] = [];
    sellOrderbooks: { amount: number, price: number }[] = [];
    tradeHistory: any[] = [];

    constructor(
        private socketService: SocketService,
        private futuresMarketService: FuturesMarketsService,
    ) {}

    get selectedMarket() {
        return this.futuresMarketService.selectedContract;
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
        const contractid = this.selectedMarket.contractId
        const filteredOrderbook = this.rawOrderbookData.filter(o => o.contractId === contractid && o.isBuy === isBuy);
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
