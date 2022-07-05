import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
// import { AddressService } from "./address.service";
import { ApiService } from "./api.service";
import { AuthService } from "./auth.service";
import { BalanceService } from "./balance.service";
import { LiquidityProviderService } from "./liquidity-provider.service";
import { LoadingService } from "./loading.service";
import { SocketService } from "./socket.service";
import { TxsService } from "./spot-services/txs.service";

interface ITradeConf {
    keypair: {
        address: string;
        pubkey: string;
    };
    action: "BUY" | "SELL";
    type: "SPOT" | "FUTURES";
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
        // more ..
    };
}

@Injectable({
    providedIn: 'root',
})

export class TradeService {
    constructor(
        private socketService: SocketService,
        // private addressService: AddressService,
        private loadingService: LoadingService,
        private toastrService: ToastrService,
        private txsService: TxsService,
        private balanceService: BalanceService,
        private liquidityProviderService: LiquidityProviderService,
        private authService: AuthService,
    ) {
        // this.handleTradeSocketEvents();
    }

    get keyPair() {
        return this.authService.activeMainKey;
    }

    get socket() {
        return this.socketService.socket;
    }

    private handleTradeSocketEvents() {
        this.socket.on('OBSERVER::order:error', (message: string) => {
            this.toastrService.error(message || `Undefined Error`, 'Error');
            this.loadingService.tradesLoading = false;
        });

        this.socket.on('OBSERVER::order:saved', (data: any) => {
            this.loadingService.tradesLoading = false;
            this.balanceService.updateBalances();
            this.toastrService.success(`The Order is Saved in Orderbook`, "Success");
        });

        this.socket.on('trade:error', (message: string) => {
            this.toastrService.error(message || `Unknow Error`, "Error");
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
    
    newOrder(orderConf: ISpotTradeConf | IFuturesTradeConf) {
        this.loadingService.tradesLoading = true;
        this.socket.emit('new-order', orderConf);
    }
}
