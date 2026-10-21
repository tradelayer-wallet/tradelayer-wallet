import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { RpcService } from "./rpc.service";
import { obEventPrefix, SocketService } from "./socket.service";
import { TxsService } from "./txs.service";
import { LoadingService } from "./loading.service";
import { BuySwapper, SellSwapper, ITradeInfo, TSwapResult } from 'src/app/utils/swapper';
import { parseNewChannel } from 'src/app/utils/swapper/protocol';
import { MAX_REASON_LENGTH, SWAP_EVENT, SwapEvent } from 'src/app/utils/swapper/common';
import { ESounds, SoundsService } from "./sound.service";
import { OrderLedgerService } from "./order-ledger.service";

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
        private orderLedger: OrderLedgerService,
    ) {}

    private get socket() {
        return this.socketService.socket;
    }

    onInit() {
        // The orderbook drops a socket's resting orders when it disconnects, so the orders this wallet
        // placed end with the orderbook connection.
        this.socket.on(`${obEventPrefix}::connect`, () => this.orderLedger.clear());
        this.socket.on(`${obEventPrefix}::disconnect`, () => this.orderLedger.clear());
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
            // The orderbook names the trade, this wallet's side included. A swap starts only for a trade that
            // fits an open order this wallet placed (order-ledger.ts); its amount is reserved until the swap ends.
            const claim = this.orderLedger.reserve(tradeInfo, isBuyer);
            if (!claim.reservation) {
                this.refuse(sessionId, isBuyer ? tradeInfo.buyer.socketId : tradeInfo.seller.socketId, claim.error);
                return;
            }
            this.activeSessions.add(sessionId);
            let res: TSwapResult | null = null;
            try {
                res = await this.channelSwap(sessionId, tradeInfo, isBuyer);
                this.report(res);
            } finally {
                this.activeSessions.delete(sessionId);
                // An aborted swap traded nothing. A settled one filled the reserved amount, and an unverified
                // one may have, so both keep it.
                if (!res || res.status === 'aborted') this.orderLedger.release(claim.reservation);
            }
        });
    }

    // Ends a swap this wallet will not take part in, at once, so the orderbook does not wait out its timer.
    private refuse(sessionId: string, mySocketId: string, reason = 'Swap offer refused') {
        const text = `Swap offer refused: ${reason}`.slice(0, MAX_REASON_LENGTH);
        this.socket.emit(SWAP_EVENT, new SwapEvent(sessionId, 'TERMINATE_TRADE', mySocketId, text));
        this.toastrService.error(text, 'Trade Error');
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
