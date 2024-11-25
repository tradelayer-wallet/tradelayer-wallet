import { Injectable } from "@angular/core";
import { LoadingService } from "../loading.service";
import { SocketService } from "../socket.service";
import { IFuturesOrder } from "./futures-orderbook.service";

interface ITradeConf {
    keypair: {
        address: string;
        pubkey: string;
    };
    action: "BUY" | "SELL";
    type: "FUTURES";
    isLimitOrder: boolean;
    marketName: string;
}

export interface IFuturesTradeConf extends ITradeConf {
    props: {
        contract_id: number,
        amount: number,
        price: number,
        levarage: number;
        collateral: number;
        transfer: boolean;
    };
}

@Injectable({
    providedIn: 'root',
})

export class FuturesOrdersService {
    private _openedOrders: IFuturesOrder[] = [];
    private _orderHistory: any[] = [];

    constructor(
        private socketService: SocketService,
        private loadingService: LoadingService,
    ) { }

    get socket() {
        return this.socketService.socket;
    }

    get openedOrders(): IFuturesOrder[] {
        return this._openedOrders;
    }

    set openedOrders(value: IFuturesOrder[]) {
        this._openedOrders = value;
    }

    get orderHistory() {
        return this._orderHistory;
    }

    set orderHistory(value: any[]) {
        this._orderHistory = value;
    }


    newOrder(orderConf: IFuturesTradeConf) {
        this.loadingService.tradesLoading = true;
        this.socket.send(JSON.stringify({ event: 'new-order', data: orderConf }));
    }

    addLiquidity(orders: IFuturesTradeConf[]) {
        this.socket.send(JSON.stringify({ event: 'many-orders', data: orders }));
    }

    closeOpenedOrder(uuid: string) {
        this.socket.send(JSON.stringify({ event: 'close-order', data: uuid }));
    }

    closeAllOrders() {
        this._openedOrders.forEach(o => this.closeOpenedOrder(o.uuid));
    }
}
