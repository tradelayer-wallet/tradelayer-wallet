import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { RpcService } from "./rpc.service";
import { obEventPrefix, SocketService } from "./socket.service";
import { TxsService } from "./txs.service";
import { LoadingService } from "./loading.service";
import { BuySwapper, SellSwapper, ITradeInfo, isSessionId } from 'src/app/utils/swapper';
import { ISpotOrder } from "./spot-services/spot-orderbook.service";
import { IFuturesOrder } from "./futures-services/futures-orderbook.service";
import { ESounds, SoundsService } from "./sound.service";

interface IChannelSwapData {
    sessionId: string;
    tradeInfo: ITradeInfo;
    unfilled: ISpotOrder | IFuturesOrder;
    isBuyer: boolean;
}

// Text that came from the counterparty or the server, shown in a toast: control
// characters removed and length bounded. Toastr renders it as text (enableHtml is off).
const toastText = (value: unknown, fallback: string): string => {
    if (typeof value !== 'string') return fallback;
    const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 256);
    return clean || fallback;
};

@Injectable({
    providedIn: 'root',
})

export class SwapService {
    private readonly activeSessions = new Set<string>();

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
                // A swap is identified only by the server-issued sessionId. Without a
                // well-formed one no event can be sent or accepted, so refuse the swap.
                const sessionId = swapConfig?.sessionId;
                if (!isSessionId(sessionId)) {
                    this.toastrService.error('Swap session id missing or malformed', 'Trade Error');
                    return;
                }
                // A second new-channel for a live session would start a second state
                // machine on the same session (double signing). Refuse it; keep the first.
                if (this.activeSessions.has(sessionId)) {
                    this.toastrService.error('Swap session already active', 'Trade Error');
                    return;
                }
                this.activeSessions.add(sessionId);
                try {
                    const res = await this.channelSwap(sessionId, swapConfig.tradeInfo, swapConfig.isBuyer);
                    if (res.error || !res.data?.txid) {
                        this.toastrService.error(toastText(res.error, 'Trade failed'), 'Trade Error');
                    } else {
                        this.soundsService.playSound(ESounds.TRADE_COMPLETED);
                    }
                } finally {
                    this.activeSessions.delete(sessionId);
                }
                // const mySocketId = swapConfig.isBuyer
                //     ? swapConfig.tradeInfo.buyer.socketId
                //     : swapConfig.tradeInfo.seller.socketId;
                // const unffiledSocketIf = swapConfig.unfilled?.socket_id;
                // const takerSocketId = swapConfig.tradeInfo?.taker;
                // if (unffiledSocketIf !== mySocketId && takerSocketId === mySocketId) {
                //     this.loadingService.tradesLoading = false;
                // }
        });
    }

    private async channelSwap(sessionId: string, tradeInfo: ITradeInfo, isBuyer: boolean) {
        const { buyer, seller, props, type } = tradeInfo;
        const swapper = isBuyer
            ? new BuySwapper(sessionId, type, props, buyer, seller, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService)
            : new SellSwapper(sessionId, type, props, seller, buyer, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService);
        swapper.eventSubs$.subscribe(eventData => {
            this.toastrService.info(toastText(eventData.eventName, 'Counterparty update'), 'Trade Info', { timeOut: 3000 });
        });
        return swapper.ready;
    }
}