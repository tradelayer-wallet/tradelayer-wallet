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

    // private handleTradeSocketEvents() {
    //     this.socket.on('trade:error', (message: string) => {
    //         this.toastrService.error(message || `Unknow Error`, "Error");
    //         this.balanceService.updateBalances();
    //     });

    //     this.socket.on('trade:success', async (_data: any) => {
    //         const { data, trade } = _data;
    //         const { txid, seller } = data;
    //         const tradeData = {
    //             propId: seller ? trade.propIdForSale : trade.propIdDesired,
    //             amount: seller ? trade.amountForSale : trade.amountDesired,
    //         };
    //         this.txsService.addTxToPending(txid, tradeData);
    //         this.toastrService.info(`Successful Trade!` || `Unknow Message`, "Success");
    //         this.balanceService.updateBalances();
    //     });

    //     this.socket.on('trade:completed', () => {
    //         this.loadingService.tradesLoading = false;
    //         this.balanceService.updateBalances();
    //     });
    // }
    
    newOrder(orderConf: ISpotTradeConf | IFuturesTradeConf) {
        this.loadingService.tradesLoading = true;
        this.socket.emit('new-order', orderConf);
    }
}
