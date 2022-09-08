import { Injectable } from "@angular/core";
import { BuySwapper, ITradeInfo, SellSwapper } from "src/app/utils/swapper.util";
import { RpcService } from "./rpc.service";
import { obEventPrefix, SocketService } from "./socket.service";
import { TxsService } from "./txs.service";

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
    filled: boolean;
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
    ) {}

    private get socket() {
        return this.socketService.socket;
    }

    onInit() {
        this.socket.on(`${obEventPrefix}::new-channel`, async (swapConfig: IRawChannelSwap) => {
            console.log({ swapConfig });
                const res = await this.channelSwap(swapConfig);
                console.log({ res });
                // res.error || res.data
                //     ? this.walletSocket.emit('trade:error', res.error)
                //     : this.walletSocket.emit('trade:success', { data: res.data, trade });  
                //     if (trade.filled && (trade?.secondSocketId === this.socket.id)) this.walletSocket.emit('trade:completed', true);
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