import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { AddressService } from "../address.service";
import { ApiService } from "../api.service";
import { BalanceService } from "../balance.service";
import { LiquidityProviderService } from "../liquidity-provider.service";
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
        private balanceService: BalanceService,
        private liquidityProviderService: LiquidityProviderService
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
            this.balanceService.updateBalances();
        });

        this.socket.on('trade:saved', (data: any) => {
            this.loadingService.tradesLoading = false;
            const lpAddresses = this.liquidityProviderService.liquidityAddresses.map(e => e.address);
            if (!lpAddresses.includes(data?.data?.address)) this.toastrService.success(`The Order is Saved in Orderbook`, "Success");
            this.balanceService.updateBalances();
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
            this.balanceService.updateBalances();
        });

        this.socket.on('trade:completed', () => {
            this.loadingService.tradesLoading = false;
            this.balanceService.updateBalances();
        });
    }

    async initNewTrade(trade: ITradeConf) {
        this.loadingService.tradesLoading = true;
        const res = await this.ssApi.postInitTrade(trade, this.keyPair).toPromise();
        this.balanceService.updateBalances();
    }
}
