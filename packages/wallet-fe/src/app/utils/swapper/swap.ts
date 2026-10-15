import { Socket as SocketClient } from 'socket.io-client';
import { Subject } from "rxjs";
import { TxsService } from "src/app/@core/services/txs.service";
import {
    ETradeType, IBuyerSellerInfo, IFuturesTradeProps, IMSChannelData, ISpotTradeProps, isSessionId,
    MAX_REASON_LENGTH, NEGOTIATION_TIMEOUT_MS, SIGNED_WINDOW_MS, SWAP_EVENT, SwapEvent, TClient,
} from "./common";
import { ISwapRelay, parseSwapRelay } from "./protocol";

// How a swap ends. `settled` is recorded by the orderbook. `unverified` means the wallet cannot tell
// whether the trade happened: the txid, if the wallet knows it, is shown so the user can check the chain.
export type TSwapResult =
    | { status: 'settled'; txid: string; trade: IFuturesTradeProps | ISpotTradeProps }
    | { status: 'aborted'; reason: string }
    | { status: 'unverified'; txid: string | null };

export abstract class Swap {
    eventSubs$: Subject<ISwapRelay> = new Subject();
    multySigChannelData: IMSChannelData | null = null;
    readonly ready: Promise<TSwapResult>;
    private resolveReady: (value: TSwapResult) => void = () => {};
    // Set exactly once, by finish(). Nothing is sent or handled after it.
    private finished = false;
    // Set at the point of no return: from here the wallet may broadcast, so it never terminates the
    // swap. The seller sets it when it sends its signature, the buyer when it sends the transaction.
    protected committed = false;
    // Protocol steps already handled. Each step arrives at most once, so a replayed step is dropped.
    private readonly handled = new Set<string>();
    // The one timer of the swap: the negotiation timer, then the signed window (see arm()).
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        // Server-issued id of this swap, taken from `new-channel`. Every event this swap sends carries
        // it, and every inbound event must match it.
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
        this.ready = new Promise<TSwapResult>((res) => { this.resolveReady = res; });
        this.socket.on(SWAP_EVENT, this.onSwapEvent);
        this.arm(NEGOTIATION_TIMEOUT_MS, () => this.terminateTrade('Negotiation timed out'));
    }

    // The only place a swap event is sent. Nothing is sent once the swap has ended.
    protected emitSwapEvent(eventName: string, data: unknown = null): void {
        if (this.finished) return;
        this.socket.emit(SWAP_EVENT, new SwapEvent(this.sessionId, eventName, this.myInfo.socketId, data));
    }

    // Listener for this session only. Fails closed: a relay that does not parse, a relay of another
    // session, a finished swap, and a repeated step are all dropped before any handler runs.
    protected onSwapEvent = (raw: unknown) => {
        if (this.finished) return;
        const relay = parseSwapRelay(raw);
        if (!relay.data || relay.data.sessionId !== this.sessionId) return;
        const event = relay.data;
        if (this.handled.has(event.eventName)) return;
        this.handled.add(event.eventName);
        this.eventSubs$.next(event);
        if (event.eventName === 'SERVER:STATE') {
            this.onServerState(event.data as { state: string; txid: string | null });
            return;
        }
        if (event.eventName === 'TERMINATE_TRADE') {
            // The counterparty ended the swap. The orderbook refuses TERMINATE_TRADE after the seller's
            // signature, so this is only reached before the point of no return. Nothing is sent back.
            if (!this.committed) this.finish({ status: 'aborted', reason: (event.data as string | null) ?? 'Undefined Reason' });
            return;
        }
        // Only SERVER:STATE has no sender; every other relayed step carries the sender's socket id.
        if (event.socketId === null) return;
        this.handleSwapEvent(event as ISwapRelay & { socketId: string });
    };

    protected abstract handleSwapEvent(event: ISwapRelay & { socketId: string }): void;

    // The txid this side can name when the outcome is unverified: the one it built or signed.
    protected abstract outcomeTxid(): string | null;

    // The orderbook's verdict. It arrives once the orderbook has the outcome, so it decides the result.
    private onServerState(state: { state: string; txid: string | null }): void {
        if (state.state === 'settled' && state.txid) {
            this.finish({ status: 'settled', txid: state.txid, trade: this.tradeInfo });
        } else if (state.state === 'aborted') {
            this.finish({ status: 'aborted', reason: 'The orderbook ended the swap' });
        } else if (state.state === 'expired-unverified') {
            this.finish({ status: 'unverified', txid: this.outcomeTxid() });
        }
    }

    // From the seller's signature on, the orderbook gives the buyer a bounded time to report. Both
    // sides wait that long, then report the outcome as unverified.
    protected startSignedWindow(): void {
        this.arm(SIGNED_WINDOW_MS, () => this.finish({ status: 'unverified', txid: this.outcomeTxid() }));
    }

    // Sends TERMINATE_TRADE to the counterparty and ends the swap as aborted. Does nothing once the swap
    // has ended or passed the point of no return.
    terminateTrade(reason: string = 'No info'): void {
        if (this.finished || this.committed) return;
        this.emitSwapEvent('TERMINATE_TRADE', reason.slice(0, MAX_REASON_LENGTH));
        this.finish({ status: 'aborted', reason });
    }

    private arm(ms: number, onFire: () => void): void {
        this.disarm();
        this.timer = setTimeout(() => {
            this.timer = null;
            onFire();
        }, ms);
        // Under Node (the tests) a timer does not keep the process alive. No-op in the browser.
        (this.timer as any)?.unref?.();
    }

    private disarm(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    // The one exit: listener removed, timer cleared, result resolved once.
    protected finish(result: TSwapResult): void {
        if (this.finished) return;
        this.finished = true;
        this.disarm();
        // Removes only this session's listener. A bare off(event) would also remove every other
        // concurrent session's listener on this socket.
        this.socket.off(SWAP_EVENT, this.onSwapEvent);
        this.eventSubs$.complete();
        this.resolveReady(result);
    }

    // True once the swap has ended. A step that awaits before a broadcast checks it again.
    protected get isFinished(): boolean {
        return this.finished;
    }
}
