import { Injectable } from "@angular/core";
import { LoadingService } from "./loading.service";
import { SocketService } from "./socket.service";

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

export interface IFuturesTradeConf extends ITradeConf {
    props: {
        contract_id: number,
        amount: number,
        price: number,
    };
}

@Injectable({
    providedIn: 'root',
})

export class TradeService {
    constructor(
        private socketService: SocketService,
        private loadingService: LoadingService,
    ) { }
    get socket() {
        return this.socketService.socket;
    }
    
    newOrder(orderConf: ISpotTradeConf | IFuturesTradeConf) {
        this.loadingService.tradesLoading = true;
        this.socket.emit('new-order', orderConf);
    }
}
