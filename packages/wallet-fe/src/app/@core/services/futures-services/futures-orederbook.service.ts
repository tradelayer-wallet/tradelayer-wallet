import { Injectable } from "@angular/core";
import { Subject } from "rxjs";
import { FuturesMarketsService } from "./futures-markets.service";
import { SocketService } from "../socket.service";

interface IFuturesOrderbook {
    action: "SELL" | "BUY",
    keypair: {
        address: string;
        pubkey: string;
    },
    lock: boolean;
    props: {
        amount: number;
        contract_id: number,
        price: number;
    };
    socket_id: string;
    timestamp: number;
    type: "SPOT";
    uuid: string;
}

@Injectable({
    providedIn: 'root',
})

export class FuturesOrderbookService {
    private _rawOrderbookData: IFuturesOrderbook[] = [];
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

    set rawOrderbookData(value: IFuturesOrderbook[]) {
        this._rawOrderbookData = value;
        this.structureOrderBook();
    } 

    private get socket() {
        return this.socketService.socket;
    }

    get marketFilter() {
        return this.futuresMarketService.marketFilter;
    }

    subscribeForOrderbook() {
        this.endOrderbookSbuscription();
        
        this.socket.on('OBSERVER::update-orders-request', () => {
            this.socket.emit('update-orderbook', this.marketFilter);
        });

        this.socket.on('OBSERVER::orderbook-data', (orderbookData: IFuturesOrderbook[]) => {
            this.rawOrderbookData = orderbookData;
        });

        this.socket.on('OBSERVER::trade-history', (tradesHistory: any) => {
            this.tradeHistory = tradesHistory;
        });

        this.socket.emit('update-orderbook', this.marketFilter);
    }

    endOrderbookSbuscription() {
        ['update-orders-request', 'orderbook-data', 'trade-history']
            .forEach(m => this.socket.off(`OBSERVER::${m}`));
    }

    private structureOrderBook() {
        this.buyOrderbooks = this._structureOrderbook(true);
        this.sellOrderbooks = this._structureOrderbook(false);
    }

    private _structureOrderbook(isBuy: boolean) {
        const contractid = this.selectedMarket.contractId
        const filteredOrderbook = isBuy 
            ? this.rawOrderbookData.filter(o => o.props.contract_id === contractid && o.action === "BUY")
            : this.rawOrderbookData.filter(o => o.props.contract_id === contractid && o.action === "SELL");
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
        return isBuy
        ? result.sort((a, b) => b.price - a.price).slice(0, 9)
        : result.sort((a, b) => b.price - a.price).slice(Math.max(result.length - 9, 0));
    }
}
