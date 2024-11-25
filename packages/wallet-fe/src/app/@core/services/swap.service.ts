import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { RpcService } from "./rpc.service";
import { obEventPrefix, SocketService } from "./socket.service";
import { Subject, Subscription } from "rxjs";
import { TxsService } from "./txs.service";
import { LoadingService } from "./loading.service";
import { BuySwapper, SellSwapper, ITradeInfo } from 'src/app/utils/swapper/';
import { ISpotTradeProps, IFuturesTradeProps } from 'src/app/utils/swapper/common'; 
import { ISpotOrder } from "./spot-services/spot-orderbook.service";
import { IFuturesOrder } from "./futures-services/futures-orderbook.service";
import { ESounds, SoundsService } from "./sound.service";
//import WebSocket, { MessageEvent } from 'ws';

interface IChannelSwapData {
    tradeInfo: ITradeInfo<any>;
    unfilled: ISpotOrder | IFuturesOrder; // if using futures logic
    isBuyer: boolean;
}

@Injectable({
    providedIn: 'root',
})

export class SwapService {
    private subscription: Subscription;
    constructor(
        private socketService: SocketService,
        private rpcService: RpcService,
        private txsService: TxsService,
        private toastrService: ToastrService,
        private loadingService: LoadingService,
        private soundsService: SoundsService,
    ) {}

    private get socket() {
        return this.socketService.socket;
    }

    onInit() {
         this.subscription = this.socketService.events$.subscribe( async (data) => {
        
            console.log('data in swap service '+data)
            try{
            const swapConfig: IChannelSwapData = data;
                this.loadingService.tradesLoading = false;

            const res = await this.channelSwap(swapConfig.tradeInfo, swapConfig.isBuyer);
                console.log('trade completed ' + JSON.stringify(res));

                if (!res || res.error || !res.data?.txid) {
                    this.toastrService.error(res?.error || 'Unknown Error', 'Trade Error');
                } else {
                    this.soundsService.playSound(ESounds.TRADE_COMPLETED);
                    this.toastrService.success('Trade Completed', res.data.txid, { timeOut: 3000 });
                }
            } catch (error) {
                this.toastrService.error('Failed to process trade: ' + error.message, 'Trade Error');
            }
        });
    }

    private async channelSwap(tradeInfo: ITradeInfo<any>, isBuyer: boolean) {
        const { buyer, seller, props, type } = tradeInfo;

        if (type === 'SPOT') {
            const { transfer } = props as ISpotTradeProps;

            // Construct the swap logic based on whether the user is the buyer or seller
            const swapper = isBuyer
                ? new BuySwapper(type, props, buyer, seller, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService, this.toastrService)
                : new SellSwapper(type, props, seller, buyer, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService, this.toastrService);

            swapper.eventSubs$.subscribe(eventData => {
                this.toastrService.info(eventData.eventName, 'Trade Info', { timeOut: 3000 });
            });

            const res = await swapper.onReady();
            return res;
        } else if (type === 'FUTURES') {
            const { transfer } = props as IFuturesTradeProps;

            const swapper = isBuyer
                ? new BuySwapper(type, props, buyer, seller, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService, this.toastrService)
                : new SellSwapper(type, props, seller, buyer, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService, this.toastrService);

            swapper.eventSubs$.subscribe(eventData => {
                this.toastrService.info(eventData.eventName, 'Trade Info', { timeOut: 3000 });
            });

            const res = await swapper.onReady();
            return res;
        } else {
            throw new Error(`Unsupported trade type: ${type}`);
        }
    }

    // Method to connect WebSocket
    /*private connectWebSocket(): WebSocket {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            this.socket = new WebSocket(URL); // Replace with your WebSocket URL
            this.socket.onopen = () => {
                console.log('WebSocket connection established');
            };
            this.socket.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
            this.socket.onclose = () => {
                console.log('WebSocket connection closed');
                // Optionally, reconnect logic can be added here
            };
        }
        return this.socket;
    }*/
}
