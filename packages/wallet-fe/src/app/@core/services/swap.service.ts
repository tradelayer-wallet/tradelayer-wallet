import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { RpcService } from "./rpc.service";
import { obEventPrefix, SocketService } from "./socket.service";
import { TxsService } from "./txs.service";
import { LoadingService } from "./loading.service";
// swap.service.ts
import { BuySwapper, SellSwapper, ITradeInfo } from 'src/app/utils/swapper/'; // Keep this import for other classes
import { ISpotTradeProps } from 'src/app/utils/swapper/common'; // Import ISpotTradeProps from common.ts

import { ISpotOrder } from "./spot-services/spot-orderbook.service";
import { ESounds, SoundsService } from "./sound.service";

interface IChannelSwapData {
    tradeInfo: ITradeInfo<any>; // Changed to any since tradeInfo could be either spot or futures
    unfilled: ISpotOrder; // Or could be IFuturesOrder if using futures logic
    isBuyer: boolean;
}

@Injectable({
    providedIn: 'root',
})

export class SwapService {
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

        if (type === "SPOT") {
            const swapper = isBuyer
                ? new BuySwapper(type, props, buyer, seller, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService, this.toastrService)
                : new SellSwapper(type, props, seller, buyer, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService, this.toastrService);

            swapper.eventSubs$.subscribe(eventData => {
                this.toastrService.info(eventData.eventName, 'Trade Info', { timeOut: 3000 });
            });

            const res = await swapper.onReady();
            return res;
        } else if (type === "FUTURES") {
            // Add futures swapper logic if needed here
            throw new Error("Futures trading not supported yet.");
        } else {
            throw new Error(`Unsupported trade type: ${type}`);
        }
    }
}
