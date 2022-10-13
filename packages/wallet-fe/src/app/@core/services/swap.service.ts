import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { RpcService } from "./rpc.service";
import { obEventPrefix, SocketService } from "./socket.service";
import { TxsService } from "./txs.service";
import { LoadingService } from "./loading.service";
import { BuySwapper, SellSwapper, ITradeInfo } from 'src/app/utils/swapper';

interface IRawChannelSwap {
    amountDesired: number;
    amountForSale: number;
    buyerAddress: string;
    buyerPubKey: string;
    buyerSocketId: string;
    sellerAddress: string;
    sellerPubKey: string;
    sellerSocketId: string;
    secondSocketId: string;
    propIdDesired: number;
    propIdForSale: number;
    unfilled: any;
    buyer: boolean;
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
        this.socket.on(`${obEventPrefix}::new-channel`, async (swapConfig: IRawChannelSwap) => {
                const res = await this.channelSwap(swapConfig);
                if (res.error || !res.data?.txid) {
                    this.toastrService.error(res.error, 'Trade Error')
                } else {
                    this.toastrService.success(res.data.txid, 'Trade Success')
                }
                const mySocketId = swapConfig.buyer ? swapConfig.buyerSocketId : swapConfig.sellerSocketId;
                if (swapConfig.unfilled?.socket_id !== mySocketId && swapConfig?.secondSocketId === mySocketId) {
                    this.loadingService.tradesLoading = false;
                }
        });
    }

    private async channelSwap(swapConfig: IRawChannelSwap) {
        const { amountDesired, amountForSale, propIdDesired, propIdForSale, 
            buyerAddress, buyerPubKey, buyerSocketId,
            sellerAddress, sellerPubKey, sellerSocketId,
            buyer,
        } = swapConfig;
        const tradeInfo: ITradeInfo = {
            amountDesired,
            amountForSale,
            propIdDesired,
            propIdForSale,
        };
        const buyerObj = { address: buyerAddress, pubKey: buyerPubKey, socketId: buyerSocketId };
        const sellerObj = { address: sellerAddress, pubKey: sellerPubKey, socketId: sellerSocketId };
        const swapper = buyer
            ? new BuySwapper(tradeInfo, buyerObj, sellerObj, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService)
            : new SellSwapper(tradeInfo, sellerObj, buyerObj, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService);
        const res = await swapper.onReady();
    return res;
    }
}