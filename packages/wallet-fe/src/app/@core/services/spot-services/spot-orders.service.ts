import { Injectable } from "@angular/core";
import { LoadingService } from "../loading.service";
import { obEventPrefix, SocketService } from "../socket.service";
import { ISpotOrder } from "./spot-orderbook.service";

interface ITradeConf {
    keypair: {
        address: string;
        pubkey: string;
    };
    action: "BUY" | "SELL";
    type: "SPOT" | "FUTURES";
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
    private _openedOrders: ISpotOrder[] = []
    constructor(
        private socketService: SocketService,
        private loadingService: LoadingService,
    ) {
        this._subscribeToSocketEvents()
    }

    get socket() {
        return this.socketService.socket;
    }

    get openedOrders(): ISpotOrder[] {
        return this._openedOrders;
    }

    set openedOrders(value: ISpotOrder[]) {
        this._openedOrders = value;
    }

    private _subscribeToSocketEvents() {
        this.socket.on(`${obEventPrefix}::placed-orders`, (openedOrders: ISpotOrder[]) => {
            this.openedOrders = openedOrders
        });

        this.socket.on(`${obEventPrefix}::disconnect`, () => {
            this.openedOrders = [];
        });
    }

    newOrder(orderConf: ISpotTradeConf) {
        this.loadingService.tradesLoading = true;
        this.socket.emit('new-order', orderConf);
    }

    closeOpenedOrder(uuid: string) {
        this.socket.emit('close-order', uuid);
    }
}
