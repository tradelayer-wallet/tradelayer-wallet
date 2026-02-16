import { Injectable } from "@angular/core";
import { LoadingService } from "../loading.service";
import { SocketService } from "../socket.service";
import { OrderRouterService } from "../order-router.service";
import { P2PSettingsService } from "../p2p-settings.service";
import { P2PMyOrdersService } from "../p2p-my-orders.service";
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
        private orderRouter: OrderRouterService,
        private p2pSettings: P2PSettingsService,
        private p2pOrders: P2PMyOrdersService,
    ) { }

    get socket() {
        return this.socketService.socket;
    }

    get openedOrders(): IFuturesOrder[] {
        if (this.p2pSettings.mode !== 'CENTRAL') return this.p2pOrders.getOpened('FUTURES') as any;
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
        void this.orderRouter.submitNewOrder(orderConf);
    }

    addLiquidity(orders: IFuturesTradeConf[]) {
        void this.orderRouter.submitManyOrders(orders as any[]);
    }

    closeOpenedOrder(uuid: string) {
        this.orderRouter.closeOpenedOrder(uuid, 'FUTURES');
    }

    closeAllOrders() {
        this._openedOrders.forEach(o => this.closeOpenedOrder(o.uuid));
    }
}
