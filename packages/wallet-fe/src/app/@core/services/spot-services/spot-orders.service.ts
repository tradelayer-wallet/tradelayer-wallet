import { Injectable } from "@angular/core";
import { LoadingService } from "../loading.service";
import { SocketService } from "../socket.service";
import { OrderRouterService } from "../order-router.service";
import { P2PSettingsService } from "../p2p-settings.service";
import { P2PMyOrdersService } from "../p2p-my-orders.service";
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
        private orderRouter: OrderRouterService,
        private p2pSettings: P2PSettingsService,
        private p2pOrders: P2PMyOrdersService,
    ) { }

    get socket() {
        return this.socketService.socket;
    }

    get openedOrders(): ISpotOrder[] {
        if (this.p2pSettings.mode !== 'CENTRAL') return this.p2pOrders.getOpened('SPOT') as any;
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
        void this.orderRouter.submitNewOrder(orderConf);
    }

    addLiquidity(orders: ISpotTradeConf[]) {
        void this.orderRouter.submitManyOrders(orders as any[]);
    }

    closeOpenedOrder(uuid: string) {
        this.orderRouter.closeOpenedOrder(uuid, 'SPOT');
    }

    closeAllOrders() {
        this._openedOrders.forEach(o => this.closeOpenedOrder(o.uuid));
    }
}
