import { Injectable } from "@angular/core";
import { LoadingService } from "../loading.service";
import { SocketService } from "../socket.service";
import { ISpotOrder } from "./spot-orderbook.service";
import { withOrderDecimals } from "src/app/utils/order-decimals";

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
        // Converted first: a value that cannot be sent exactly throws before the loading flag is set.
        const order = withOrderDecimals(orderConf);
        this.loadingService.tradesLoading = true;
        this.socket.emit('new-order', order);
    }

    addLiquidity(orders: ISpotTradeConf[]) {
        this.socket.emit('many-orders', orders.map(withOrderDecimals));
    }

    closeOpenedOrder(uuid: string) {
        this.socket.emit('close-order', uuid);
    }

    closeAllOrders() {
        this._openedOrders.forEach(o => this.closeOpenedOrder(o.uuid));
    }
}
