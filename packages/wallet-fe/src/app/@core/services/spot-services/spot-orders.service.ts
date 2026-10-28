import { Injectable } from "@angular/core";
import { LoadingService } from "../loading.service";
import { SocketService } from "../socket.service";
import { ISpotOrder } from "./spot-orderbook.service";
import { toWireOrder } from "src/app/utils/units";
import { OrderLedgerService } from "../order-ledger.service";

interface ITradeConf {
    keypair: {
        address: string;
        pubkey: string;
    };
    action: "BUY" | "SELL";
    type: "SPOT";
    isLimitOrder: true;
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
        private orderLedger: OrderLedgerService,
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
        const order = toWireOrder(orderConf);
        this.loadingService.tradesLoading = true;
        // Recorded as sent, before it is sent: a swap for it can start as soon as the orderbook matches it.
        this.orderLedger.record(order);
        this.socket.emit('new-order', order);
    }

    addLiquidity(orders: ISpotTradeConf[]) {
        const wire = orders.map(toWireOrder);
        wire.forEach((order) => this.orderLedger.record(order));
        this.socket.emit('many-orders', wire);
    }

    closeOpenedOrder(uuid: string) {
        const order = this._openedOrders.find((o: any) => o.uuid === uuid) as any;
        if (order?.keypair && order?.props) this.orderLedger.forget(order);
        this.socket.emit('close-order', uuid);
    }

    closeAllOrders() {
        this._openedOrders.forEach(o => this.closeOpenedOrder(o.uuid));
        this.orderLedger.clear();
    }
}
