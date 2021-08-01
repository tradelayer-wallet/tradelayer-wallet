import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { AddressService } from "./address.service";
import { ApiService } from "./api.service";
import { BalanceService } from "./balance.service";
import { DealerService } from "./dealer.service";
import { LoadingService } from "./loading.service";
import { RpcService } from "./rpc.service";
import { SocketEmits, SocketService } from "./socket.service";
import { TxsService } from "./txs.service";

export interface ITradeConf {
    amount: number,
    price: number,
    propIdDesired: number,
    propIdForSale: number,
    clientPubKey?: string,
    clientAddress?: string,
    isBuy: boolean,
    marketName: string,
}

@Injectable({
    providedIn: 'root',
})

export class TradeService {
    constructor(
        private socketService: SocketService,
        private addressService: AddressService,
        private apiService: ApiService,
        private loadingService: LoadingService,
        private toastrService: ToastrService,
        private txsService: TxsService,
    ) {
        this.handleTradeSocketEvents();
    }

    get keyPair() {
        return this.addressService.activeKeyPair;
    }

    get socket() {
        return this.socketService.socket;
    }

    get ssApi() {
        return this.apiService.socketScriptApi;
    }

    private handleTradeSocketEvents() {
        this.socket.on('trade:error', (message: string) => {
            this.toastrService.error(message || `Unknow Error`, "Error");
        });

        this.socket.on('trade:saved', (message: string) => {
            this.loadingService.isLoading = false;
            this.toastrService.success(message || `Unknow Message`, "Success");
        });

        this.socket.on('trade:success', async (data: any) => {
            const { txid } = data;
            const fee = await this.txsService.getTxFee(txid);
            this.txsService.addTxToPending(txid, fee);
            this.toastrService.info(`Successful Trade!` || `Unknow Message`, "Success");
        });

        this.socket.on('trade:completed', () => {
            this.loadingService.isLoading = false;
        });
    }

    initNewTrade(trade: ITradeConf) {
        // this._initTrade(trade);
        this.loadingService.isLoading = true;
        this.__initNewTrade(trade);
    }

    private async __initNewTrade(trade: ITradeConf) {
        const res = await this.ssApi.initTrade(trade, this.keyPair).toPromise();
    }

    // private async _initTrade(tradeConf: ITradeConf) {
    //     const savedDealer = await this.checkSavedDealers(tradeConf);
    //     if (savedDealer) return ;
    //     const dealerObj: any = await this.getDealerFromServer(tradeConf);
    //     if (!dealerObj) {
    //         this.dealerService.addToDealerTrades(tradeConf);
    //         return;
    //     }
    //     const { dealer, unfilled } = dealerObj;
    //     if (unfilled) tradeConf.amount = dealer.amount;
    //     await this.tradeWithDealer(dealer.conn, tradeConf);
    //     if (unfilled) this._initTrade(unfilled);
    // }

    // private async checkSavedDealers(tradeConf: ITradeConf) {
    //     const { savedDelalers } = window.localStorage;
    //     if (!savedDelalers?.length) return false;
    //     for (let i = 0; i < savedDelalers.length; i++) {
    //         const isGoodDeal = await this.askDealerForTrade(savedDelalers[i], tradeConf);
    //         if (isGoodDeal) {
    //             this.tradeWithDealer(savedDelalers[i], tradeConf);
    //             return true;
    //         }
    //     }
    //     return false;
    // }

    // private async getDealerFromServer(tradeConf: ITradeConf) {
    //     return await this.apiService.tradeApi.findDealerByTrade(tradeConf).toPromise();
    // }

    // private async tradeWithDealer(dealer: any, tradeConf: ITradeConf) {
    //     const result = await this.ssApi.initTrade(dealer, tradeConf, this.keyPair).toPromise();
    //     console.log({result});
    // }

    // private async askDealerForTrade(dealer: any, tradeConf: ITradeConf) {
    //     return false;
    // }

}
