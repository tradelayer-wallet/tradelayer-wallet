import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { AddressService } from "../address.service";
import { ApiService } from "../api.service";
import { LoadingService } from "../loading.service";
import { SocketService } from "../socket.service";
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
            this.loadingService.tradesLoading = false;
            this.toastrService.success(message || `Unknow Message`, "Success");
        });

        this.socket.on('trade:success', async (_data: any) => {
            const { data, trade } = _data;
            const { txid, seller } = data;
            const tradeData = {
                propId: seller ? trade.propIdForSale : trade.propIdDesired,
                amount: seller ? trade.amountForSale : trade.amountDesired,
            };
            this.txsService.addTxToPending(txid, tradeData);
            this.toastrService.info(`Successful Trade!` || `Unknow Message`, "Success");
        });

        this.socket.on('trade:completed', () => {
            this.loadingService.tradesLoading = false;
        });
    }

    async initNewTrade(trade: ITradeConf) {
        this.loadingService.tradesLoading = true;
        const res = await this.ssApi.initTrade(trade, this.keyPair).toPromise();
    }
}
