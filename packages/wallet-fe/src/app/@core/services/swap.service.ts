import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { RpcService } from "./rpc.service";
import { obEventPrefix, SocketService } from "./socket.service";
import { TxsService } from "./txs.service";
import { LoadingService } from "./loading.service";
import { BuySwapper, SellSwapper, ITradeInfo, TSwapResult } from 'src/app/utils/swapper';
import { parseNewChannel } from 'src/app/utils/swapper/protocol';
import { ESounds, SoundsService } from "./sound.service";

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
        this.socket.on(`${obEventPrefix}::new-channel`, async (raw: unknown) => {
            this.loadingService.tradesLoading = false;
            // The one check of the new-channel message. Without a well-formed one nothing is started.
            const offer = parseNewChannel(raw);
            if (!offer.data) {
                this.toastrService.error(toastText(offer.error, 'Swap offer malformed'), 'Trade Error');
                return;
            }
            const { sessionId, tradeInfo, isBuyer } = offer.data;
            // A second new-channel for a live session would start a second state
            // machine on the same session (double signing). Refuse it; keep the first.
            if (this.activeSessions.has(sessionId)) {
                this.toastrService.error('Swap session already active', 'Trade Error');
                return;
            }
            this.activeSessions.add(sessionId);
            try {
                const res = await this.channelSwap(sessionId, tradeInfo, isBuyer);
                this.report(res);
            } finally {
                this.activeSessions.delete(sessionId);
            }
        });
    }

    // Every swap ends in one of three states (protocol-v2.md B.5). Unverified shows the txid the wallet
    // holds, so the user can check the chain.
    private report(res: TSwapResult) {
        if (res.status === 'settled') {
            this.soundsService.playSound(ESounds.TRADE_COMPLETED);
        } else if (res.status === 'aborted') {
            this.toastrService.error(toastText(res.reason, 'Trade failed'), 'Trade Error');
        } else {
            const txid = res.txid ? ` Transaction ${res.txid}.` : '';
            this.toastrService.warning(`The trade outcome could not be verified.${txid} Check the chain before trading again.`, 'Trade Unverified');
        }
    }

    private async channelSwap(sessionId: string, tradeInfo: ITradeInfo, isBuyer: boolean): Promise<TSwapResult> {
        const { buyer, seller, props, type } = tradeInfo;
        const swapper = isBuyer
            ? new BuySwapper(sessionId, type, props, buyer, seller, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService)
            : new SellSwapper(sessionId, type, props, seller, buyer, this.rpcService.rpc.bind(this.rpcService), this.socket, this.txsService);
        swapper.eventSubs$.subscribe((eventData) => {
            this.toastrService.info(toastText(eventData.eventName, 'Counterparty update'), 'Trade Info', { timeOut: 3000 });
        });
        return swapper.ready;
    }
}
