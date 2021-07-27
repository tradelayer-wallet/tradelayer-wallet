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
}

@Injectable({
    providedIn: 'root',
})

export class TradeService {
    constructor(
        private socketService: SocketService,
        private addressService: AddressService,
        private dealerService: DealerService,
        private apiService: ApiService,
    ) {}

    get keyPair() {
        return this.addressService.activeKeyPair;
    }

    get socket() {
        return this.socketService.socket;
    }

    get ssApi() {
        return this.apiService.socketScriptApi;
    }

    initNewTrade(trade: ITradeConf) {
        this._initTrade(trade);
    }

    private async _initTrade(tradeConf: ITradeConf) {
        const savedDealer = await this.checkSavedDealers(tradeConf);
        if (savedDealer) return ;
        const dealerObj: any = await this.getDealerFromServer(tradeConf);
        if (!dealerObj) {
            this.dealerService.addToDealerTrades(tradeConf);
            return;
        }
        const { dealer, unfilled } = dealerObj;
        if (unfilled) tradeConf.amount = dealer.amount;
        await this.tradeWithDealer(dealer.conn, tradeConf);
        if (unfilled) this._initTrade(unfilled);
    }

    private async checkSavedDealers(tradeConf: ITradeConf) {
        const { savedDelalers } = window.localStorage;
        if (!savedDelalers?.length) return false;
        for (let i = 0; i < savedDelalers.length; i++) {
            const isGoodDeal = await this.askDealerForTrade(savedDelalers[i], tradeConf);
            if (isGoodDeal) {
                this.tradeWithDealer(savedDelalers[i], tradeConf);
                return true;
            }
        }
        return false;
    }

    private async getDealerFromServer(tradeConf: ITradeConf) {
        return await this.apiService.tradeApi.findDealerByTrade(tradeConf).toPromise();
    }

    private async tradeWithDealer(dealer: any, tradeConf: ITradeConf) {
        const result = await this.ssApi.initTrade(dealer, tradeConf, this.keyPair).toPromise();
        console.log({result});
    }

    private async askDealerForTrade(dealer: any, tradeConf: ITradeConf) {
        //
        return false;
    }

}
