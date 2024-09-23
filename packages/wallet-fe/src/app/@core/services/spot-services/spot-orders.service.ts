import { Injectable } from "@angular/core";
import { LoadingService } from "../loading.service";
import { SocketService } from "../socket.service";
import { ISpotOrder } from "./spot-orderbook.service";

interface ITradeConf {
    keypair: {
        address: string;
        pubkey: string;
    };
    action: "BUY" | "SELL";
    type: "SPOT";
    isLimitOrder: boolean;
    marketName: string;
}

export interface ISpotTradeConf extends ITradeConf {
    props: {
        id_desired: number,
        id_for_sale: number,
        amount: number,
        price: number,
        transfer?: boolean; // Add this  
    };
}

@Injectable({
    providedIn: 'root',
})

export class SpotOrdersService {
    private _openedOrders: ISpotOrder[] = [];
    private _orderHistory: any[] = [];

    constructor(
        private socketService: SocketService,
        private loadingService: LoadingService,
    ) { }

    get socket() {
        return this.socketService.socket;
    }

    get openedOrders(): ISpotOrder[] {
        return this._openedOrders;
    }

    set openedOrders(value: ISpotOrder[]) {
        this._openedOrders = value;
    }

    get orderHistory() {
        return this._orderHistory;
    }

    set orderHistory(value: any[]) {
        this._orderHistory = value;
    }

    newOrder(orderConf: ISpotTradeConf) {
        this.loadingService.tradesLoading = true;
        console.log('inside new order '+JSON.stringify(orderConf))
        this.socket.emit('new-order', orderConf);
    }

    addLiquidity(orders: ISpotTradeConf[]) {
        this.socket.emit('many-orders', orders);
    }

    closeOpenedOrder(uuid: string) {
        this.socket.emit('close-order', uuid);
    }

    closeAllOrders() {
        this._openedOrders.forEach(o => this.closeOpenedOrder(o.uuid));
    }
}
