import { TxsService } from "src/app/@core/services/txs.service";
import { ClearlistService } from "src/app/@core/services/clearlist.service";
import { ETradeType, IBuyerSellerInfo, IFuturesTradeProps, IMSChannelData, ISpotTradeProps, SwapEvent, TClient } from "./common";
import { Socket as SocketClient } from 'socket.io-client';
import { Subject } from "rxjs";

export abstract class Swap {
    readyRes: (value: { data?: any, error?: any }) => void = () => {};
    eventSubs$: Subject<SwapEvent> = new Subject();
    multySigChannelData: IMSChannelData | null = null;
    constructor(
        public typeTrade: ETradeType,
        public tradeInfo: IFuturesTradeProps | ISpotTradeProps, 
        public myInfo: IBuyerSellerInfo,
        public cpInfo: IBuyerSellerInfo,
        public client: TClient,
        public socket: SocketClient,
        public txsService: TxsService,
        public clearlistService?: ClearlistService,
    ) { }

    // Clearlist model: allow retail to counterparty with a vetted MM.
    // For clearlisted channels, require that *at least one* participant pubkey is clearlisted.
    protected async requireClearlistedIfNeeded(channelData: IMSChannelData | null) {
        const groupId = channelData?.clearlistGroupId;
        if (!groupId) return;
        if (!this.clearlistService) throw new Error('ClearlistService not configured');
        const pubkeys = [this.myInfo.keypair.pubkey, this.cpInfo.keypair.pubkey].filter(Boolean);
        const res = await this.clearlistService.checkAny(groupId, pubkeys);
        if (!res.allowed) throw new Error('No clearlisted MM found for this channel');
    }

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
