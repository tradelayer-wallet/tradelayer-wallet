import { TxsService } from "src/app/@core/services/txs.service";
import { IMSChannelData, ITradeInfo, SwapEvent, TBuyerSellerInfo, TClient } from "./common";
import { Socket as SocketClient } from 'socket.io-client';

export abstract class Swap {
    readyRes: (value: { data?: any, error?: any }) => void = () => {};
    multySigChannelData: IMSChannelData | null = null;
    constructor(
        public tradeInfo: ITradeInfo, 
        public myInfo: TBuyerSellerInfo,
        public cpInfo: TBuyerSellerInfo,
        public client: TClient,
        public socket: SocketClient,
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
        this.socket.emit(`${this.myInfo.socketId}::swap`, eventData);
        this.onTerminateTrade('', reason);
    }

    onTerminateTrade(cpId: string, reason: string = 'Undefined Reason') {
        if (this.readyRes) this.readyRes({ error: reason });
        this.removePreviuesListeners();
    }

    removePreviuesListeners() {
        this.socket.off(`${this.cpInfo.socketId}::swap`);
    }
}