import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { RpcService } from "./rpc.service";
import { obEventPrefix, SocketService } from "./socket.service";
import { TxsService } from "./txs.service";
import { LoadingService } from "./loading.service";
import { BuySwapper, SellSwapper, ITradeInfo } from 'src/app/utils/swapper';
import { ISpotOrder } from "./spot-services/spot-orderbook.service";
import { IFuturesOrder } from "./futures-services/futures-orderbook.service";

interface IChannelSwapData {
    tradeInfo: ITradeInfo;
    unfilled: ISpotOrder | IFuturesOrder;
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
    ) {}

    private get socket() {
        return this.socketService.socket;
    }

    onInit() {
        this.socket.on(`${obEventPrefix}::new-channel`, async (swapConfig: IChannelSwapData) => {
                const res = await this.channelSwap(swapConfig.tradeInfo, swapConfig.isBuyer);
                if (res.error || !res.data?.txid) {
                    this.toastrService.error(res.error, 'Trade Error')
                } else {
                    this.toastrService.success(res.data.txid, 'Trade Success')
                }
                const mySocketId = swapConfig.isBuyer
                    ? swapConfig.tradeInfo.buyer.socketId
                    : swapConfig.tradeInfo.seller.socketId;
                const unffiledSocketIf = swapConfig.unfilled?.socket_id;
                const takerSocketId = swapConfig.tradeInfo?.taker;
                if (unffiledSocketIf !== mySocketId && takerSocketId === mySocketId) {
                    this.loadingService.tradesLoading = false;
                }
        });
    }

    private async channelSwap(tradeInfo: ITradeInfo, isBuyer: boolean) {
        const { buyer, seller, props, type } = tradeInfo;
        const swapper = isBuyer
            ? new BuySwapper(type, props, buyer, seller, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService)
            : new SellSwapper(type, props, seller, buyer, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService);
        const res = await swapper.onReady();
    return res;
    }
}