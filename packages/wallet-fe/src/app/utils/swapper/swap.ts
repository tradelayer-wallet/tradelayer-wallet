import { TxsService } from "src/app/@core/services/txs.service";
import { ETradeType, IBuyerSellerInfo, IFuturesTradeProps, IMSChannelData, ISpotTradeProps, SwapEvent, TClient } from "./common";
//import WebSocket from 'ws';
import { Subject } from "rxjs";

export abstract class Swap {
    readyRes: (value: { data?: any, error?: any }) => void = () => {};
    eventSubs$: Subject<SwapEvent> = new Subject();
    multySigChannelData: IMSChannelData | null = null;
    listeners: { eventName: string, callback: (event: MessageEvent) => void }[] = [];

    constructor(
        public typeTrade: ETradeType,
        public tradeInfo: ISpotTradeProps|IFuturesTradeProps, 
        public myInfo: IBuyerSellerInfo,
        public cpInfo: IBuyerSellerInfo,
        public client: TClient,
        public socket: WebSocket,  // Changed to WebSocket
        public txsService: TxsService,
    ) { }

    onReady() {
        return new Promise<{ data?: any, error?: any }>((res) => {
            this.readyRes = res;
            setTimeout(() => this.terminateTrade('Undefined Error code 1'), 60000);
        });
    }

    terminateTrade(reason: string = 'No info'): void {
        const eventData = new SwapEvent('TERMINATE_TRADE', this.myInfo.socketId, reason);
        // Sending data through WebSocket, assuming it's serialized as a string
        this.socket.send(JSON.stringify({
            event: 'swap',
            data: eventData
        }));
        this.onTerminateTrade('', reason);
    }

    onTerminateTrade(cpId: string, reason: string = 'Undefined Reason') {
        if (this.readyRes) this.readyRes({ error: reason });
        this.removePreviuesListeners();
    }

    removePreviuesListeners() {
        if (this.listeners && this.listeners.length) {
            this.listeners.forEach(listener => {
                // Remove each event listener for WebSocket
                this.socket.removeEventListener(listener.eventName, listener.callback as () => void);
            });
        }
    }


}
