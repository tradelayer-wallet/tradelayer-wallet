import { TxsService } from "src/app/@core/services/txs.service";
import { ETradeType, IBuyerSellerInfo, IFuturesTradeProps, IMSChannelData, ISpotTradeProps, SWAP_EVENT, SwapEvent, TClient } from "./common";
import { Socket as SocketClient } from 'socket.io-client';
import { Subject } from "rxjs";

export abstract class Swap {
    readyRes: (value: { data?: any, error?: any }) => void = () => {};
    eventSubs$: Subject<SwapEvent> = new Subject();
    multySigChannelData: IMSChannelData | null = null;
    private settled = false;
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
    ) { }

    // The only place a swap event is sent. Every send goes through here, so the
    // sessionId cannot be left off.
    protected emitSwapEvent(eventName: string, data: any = null): void {
        this.socket.emit(SWAP_EVENT, new SwapEvent(this.sessionId, eventName, this.myInfo.socketId, data));
    }

    // Listener for this session only. Fails closed: an event for any other session
    // is dropped before it reaches the state machine.
    protected onSwapEvent = (eventData: SwapEvent) => {
        if (!this.sessionId || eventData?.sessionId !== this.sessionId) return;
        this.eventSubs$.next(eventData);
        this.handleSwapEvent(eventData);
    };

    protected abstract handleSwapEvent(eventData: SwapEvent): void;

    onReady() {
        return new Promise<{ data?: any, error?: any }>((res) => {
            this.readyRes = (value) => {
                this.settled = true;
                res(value);
            };
            setTimeout(() => {
                // A settled swap must not send a late TERMINATE_TRADE: the orderbook
                // server rejects events for a settled session.
                if (!this.settled) this.terminateTrade('Undefined Error code 1');
            }, 60000);
        });
    }

    terminateTrade(reason: string = 'No info'): void {
        this.emitSwapEvent('TERMINATE_TRADE', reason);
        this.onTerminateTrade('', reason);
    }

    onTerminateTrade(cpId: string, reason: string = 'Undefined Reason') {
        if (this.readyRes) this.readyRes({ error: reason });
        this.removePreviuesListeners();
    }

    removePreviuesListeners() {
        // Removes only this session's listener. A bare off(event) would also remove
        // every other concurrent session's listener on this socket.
        this.socket.off(SWAP_EVENT, this.onSwapEvent);
    }
}
