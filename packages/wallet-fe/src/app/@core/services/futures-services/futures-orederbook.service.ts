import { Injectable } from "@angular/core";
import { Subject } from "rxjs";
import { FuturesMarketsService } from "./futures-markets.service";
import { SocketService } from "../socket.service";

export interface IFuturesOrderbook {
    amount: number,
    price: number,
    contractId: number,
}

@Injectable({
    providedIn: 'root',
})

export class FuturesOrderbookService {
    private _rawBuyOrderbookData: IFuturesOrderbook[] = [];
    private _rawSellOrderbookData: IFuturesOrderbook[] = []
    outsidePriceHandler: Subject<number> = new Subject();
    buyOrderbooks: { amount: number, price: number }[] = [];
    sellOrderbooks: { amount: number, price: number }[] = [];

    constructor(
        private socketService: SocketService,
        private futuresMarketService: FuturesMarketsService,
    ) {}

    get selectedMarket() {
        return this.futuresMarketService.selectedContract;
    }

    // get rawOrderbookData() {
    //     return this._rawOrderbookData;
    // }

    // set rawOrderbookData(value: IFuturesOrderbook[]) {
    //     this._rawOrderbookData = value;
    //     this.structureOrderBook();
    // } 

    private get socket() {
        return this.socketService.socket;
    }

    subscribeForOrderbook() {
        this.endOrderbookSbuscription();
        this.socket.on('futures-orderbook-data', (orderbookData: {
            buyOrderbook: IFuturesOrderbook[]; 
            sellOrderbook: IFuturesOrderbook[]
        }) => {
            this._rawBuyOrderbookData = orderbookData.buyOrderbook;
            this._rawSellOrderbookData = orderbookData.sellOrderbook;
            this.structureOrderBook();
        });
        // this.socket.on('aksfor-orderbook-update', () => {
        //     this.socket.emit('update-orderbook');
        // });
        this.socket.emit('update-futures-orderbook');
    }

    endOrderbookSbuscription() {
        this.socket.off('futures-orderbook-data');
        // this.socket.off('aksfor-orderbook-update');
    }

    private structureOrderBook() {
        this.buyOrderbooks = this._structureOrderbook(1);
        this.sellOrderbooks = this._structureOrderbook(2);
    }

    private _structureOrderbook(tradeAction: number) {
        const rawOrderbookData = tradeAction === 1
            ? this._rawBuyOrderbookData
            : tradeAction === 2
                ? this._rawSellOrderbookData
                : [];

        const filteredOrderbook = rawOrderbookData.filter(d => d.contractId === this.selectedMarket.contractId);
        const range = 100;
        const result: { price: number, amount: number }[] = [];
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
        return tradeAction === 1 
         ? result.sort((a, b) => b.price - a.price).slice(Math.max(result.length - 9, 0))
         : tradeAction === 2
            ? result.sort((a, b) => b.price - a.price).slice(0, 9)
            : [];
    }
}
