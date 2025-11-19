import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { RpcService } from "./rpc.service";
import { obEventPrefix, SocketService } from "./socket.service";
import { TxsService } from "./txs.service";
import { LoadingService } from "./loading.service";
// swap.service.ts
import { BuySwapper, SellSwapper, ITradeInfo } from 'src/app/utils/swapper/'; // Keep this import for other classes
import { ISpotTradeProps, IFuturesTradeProps } from 'src/app/utils/swapper/common'; // Import ISpotTradeProps from common.ts

import { ISpotOrder } from "./spot-services/spot-orderbook.service";
import { IFuturesOrder} from "./futures-services/futures-orderbook.service"
import { ESounds, SoundsService } from "./sound.service";

interface IChannelSwapData {
    tradeInfo: ITradeInfo<any>; // Changed to any since tradeInfo could be either spot or futures
    unfilled: ISpotOrder|IFuturesOrder; // if using futures logic
    isBuyer: boolean;
}

@Injectable({
    providedIn: 'root',
})

export class SwapService {
    private activeSwaps = new Set<string>();

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
        this.socket.on(`${obEventPrefix}::new-channel`, async (swapConfig: IChannelSwapData) => {
            console.log('inside new channel in swap service '+JSON.stringify(swapConfig))

            this.loadingService.tradesLoading = false;
            const res = await this.channelSwap(swapConfig.tradeInfo, swapConfig.isBuyer);
            
            if (!res || res.error || !res.data?.txid) {
                this.toastrService.error(res?.error || 'Unknown Error', 'Trade Error');
            } else {
                this.soundsService.playSound(ESounds.TRADE_COMPLETED);
                this.toastrService.success('Trade Completed', res.data.txid, { timeOut: 3000 });
            }
        });
    }

    private async channelSwap(tradeInfo: ITradeInfo<any>, isBuyer: boolean) {
        const { buyer, seller, props, type } = tradeInfo;
        console.log('inside channel swap '+JSON.stringify(tradeInfo))

    // Compose a unique key for the trade.
    const key = [buyer?.uuid, seller?.uuid].join('-');
    // GUARD: If already in progress, skip!
    if (this.activeSwaps.has(key)) {
        console.warn('Duplicate swap detected, skipping:', key);
        return { error: "Duplicate swap attempt." };
    }
    // Mark as in-progress
    this.activeSwaps.add(key);
     try {    
        if (type === "SPOT") {
            const { transfer } = props as ISpotTradeProps;

            const swapper = isBuyer
                ? new BuySwapper(type, props, buyer, seller, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService, this.toastrService,key)
                : new SellSwapper(type, props, seller, buyer, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService, this.toastrService,key);

            swapper.eventSubs$.subscribe(eventData => {
                this.toastrService.info(eventData.eventName, 'Trade Info', { timeOut: 3000 });
            });

            const res = await swapper.onReady();
            return res;
        } else if (type === "FUTURES") {
            const { transfer } = props as IFuturesTradeProps;

            const swapper = isBuyer
                ? new BuySwapper(type, props, buyer, seller, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService, this.toastrService,key)
                : new SellSwapper(type, props, seller, buyer, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService, this.toastrService,key);

            swapper.eventSubs$.subscribe(eventData => {
                this.toastrService.info(eventData.eventName, 'Trade Info', { timeOut: 3000 });
            });

            const res = await swapper.onReady();
            return res;
            // Add futures swapper logic if needed here
            //throw new Error("Futures trading not supported yet.");
        } else {
            throw new Error(`Unsupported trade type: ${type}`);
        }
      }finally{
         // Always clean up, even on error!
        this.activeSwaps.delete(key);
      }
    }
}
