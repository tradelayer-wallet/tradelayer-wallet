import { TxsService } from "src/app/@core/services/txs.service";
import { ETradeType, IBuyerSellerInfo, IFuturesTradeProps, IMSChannelData, ISpotTradeProps, isSessionId, SWAP_EVENT, SwapEvent, TClient } from "./common";
import { Socket as SocketClient } from 'socket.io-client';
import { Subject } from "rxjs";

export interface ISwapResult {
    data?: any;
    error?: any;
}

export abstract class Swap {
    eventSubs$: Subject<SwapEvent> = new Subject();
    multySigChannelData: IMSChannelData | null = null;
    readonly ready: Promise<ISwapResult>;
    private resolveReady: (value: ISwapResult) => void = () => {};
    // Set exactly once, by finish(). Nothing is sent or handled after it.
    private settled = false;
    // Protocol steps already handled. Each step arrives at most once, so a replayed
    // step is dropped instead of running its handler (and its signing/broadcast) again.
    private readonly handled = new Set<string>();
    // Cleared by finish(), so a settled swap does not keep a timer (and the process) alive.
    private safetyTimer: ReturnType<typeof setTimeout> | null = null;
    constructor(
        // Server-issued id of this swap, taken from `new-channel`. Every event this
        // swap sends carries it, and every inbound event must match it.
        public readonly sessionId: string,
        public typeTrade: ETradeType,
        public tradeInfo: IFuturesTradeProps | ISpotTradeProps,
        public myInfo: IBuyerSellerInfo,
        public cpInfo: IBuyerSellerInfo,
        public client: TClient,
        public socket: SocketClient,
        public txsService: TxsService,
    ) {
        if (!isSessionId(sessionId)) throw new Error('Swap sessionId must be 64 lowercase hex characters');
        this.ready = new Promise<ISwapResult>((res) => { this.resolveReady = res; });
        this.socket.on(SWAP_EVENT, this.onSwapEvent);
        // Safety net: a swap that has not settled within 60 s is terminated. Once
        // settled the timer does nothing, so no late TERMINATE_TRADE is sent.
        this.safetyTimer = setTimeout(() => {
            if (!this.settled) this.terminateTrade('Undefined Error code 1');
        }, 60000);
        // Under Node (the tests) an unref'd timer does not keep the process alive. No-op in the browser.
        (this.safetyTimer as any)?.unref?.();
    }

    // The only place a swap event is sent. Every send goes through here, so the
    // sessionId cannot be left off, and nothing is sent once the swap has settled.
    protected emitSwapEvent(eventName: string, data: any = null): void {
        if (this.settled) return;
        this.socket.emit(SWAP_EVENT, new SwapEvent(this.sessionId, eventName, this.myInfo.socketId, data));
    }

    // Listener for this session only. Fails closed: an event for any other session,
    // a settled swap, or a repeated step is dropped before it reaches a handler.
    protected onSwapEvent = (eventData: SwapEvent) => {
        if (this.settled || eventData?.sessionId !== this.sessionId) return;
        if (this.handled.has(eventData.eventName)) return;
        this.handled.add(eventData.eventName);
        this.eventSubs$.next(eventData);
        if (eventData.eventName === 'TERMINATE_TRADE') {
            // The counterparty ended the swap. Nothing is sent back.
            this.finish({ error: eventData.data ?? 'Undefined Reason' });
            return;
        }
        this.handleSwapEvent(eventData);
    };

    protected abstract handleSwapEvent(eventData: SwapEvent): void;

    // Sends TERMINATE_TRADE to the counterparty and ends the swap. Does nothing once
    // the swap has settled.
    terminateTrade(reason: string = 'No info'): void {
        if (this.settled) return;
        this.emitSwapEvent('TERMINATE_TRADE', reason);
        this.finish({ error: reason });
    }

    // Ends the swap locally (counterparty terminated, or success). The only exit path:
    // it detaches this session's listener and completes the result exactly once.
    protected finish(result: ISwapResult): void {
        if (this.settled) return;
        this.settled = true;
        if (this.safetyTimer) clearTimeout(this.safetyTimer);
        // Removes only this session's listener. A bare off(event) would also remove
        // every other concurrent session's listener on this socket.
        this.socket.off(SWAP_EVENT, this.onSwapEvent);
        this.eventSubs$.complete();
        this.resolveReady(result);
    }
}
