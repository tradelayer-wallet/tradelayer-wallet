import { io, Socket } from "socket.io-client";
import {
    ROptions,
    Trade,
    Events1 as emmitEvents,
    Events2 as onEvents,
    TClient,
    ApiRes,
} from "../common/types";

export abstract class Receiver {
    protected socket: Socket;
    private readyRes: (value: { data?: any, error?: any }) => void;
    protected client: TClient;

    protected trade: Trade;

    protected logs: boolean = false;
    protected send: boolean = false;

    protected listenerPubkey: string;
    protected receiverPubkey: string;

    protected listenerAddress: string;
    protected receiverAddress: string;

    private multysigData: any;
    constructor(client: TClient, host: string, trade: Trade, options: ROptions) {
        const { send, logs } = options;
        this.client = client;
        this.trade = trade;
        this.send = send;
        this.logs = logs;
        this.receiverAddress = trade.address;
        this.receiverPubkey = trade.pubkey;
        this.init(host);
        this.onReady();
    }

    private onConnection(): void {
        this.log(`Connected`);
        this.handleListeners();
        this.sendTradeRequest();
    }

    onReady() {
        return new Promise<{ data?: any, error?: any }>((res) => {
            this.readyRes = res;
        });
    }

    private sendTradeRequest(): void {
        this.socket.emit(emmitEvents.TRADE_REQUEST, this.trade);
    }

    protected log(message: string, data?: any): void {
        if (this.logs) console.log(`${message} ${JSON.stringify(data, null, "\t") || ''}`);
    }

    protected init(_host: string): void {
        const host = `http://${_host}:9876`;
        this.socket = io(host);
        this.socket.on('connect', this.onConnection.bind(this));
    }

    protected close(): void {
        this.socket.close();
    }

    protected terminateTrade(reason: string = 'No info') {
        const error = `Trade Terminated! ${reason}`
        this.log(error);
        if (this.readyRes) this.readyRes({ error: reason });
        this.close();
        return { error };
    }

    private handleListeners(): void {
        this.socket.on(onEvents.REJECT_TRADE, this.onTradeReject.bind(this));
        this.socket.on(onEvents.TERMINATE_TRADE, this.onTradeTerminate.bind(this));
        this.socket.on(onEvents.SIGNED_RAWTX, this.onSignedRawTx.bind(this));
        this.socket.on(onEvents.MULTYSIG_DATA, this.onMultysigData.bind(this));
    }

    private onTradeReject(reason: string): void {
        const message = `Trade Rejected!! Reason: ${reason}`;
        this.terminateTrade(message);
    }

    private onTradeTerminate(reason: string): void {
        const message = `Trade Terminated!! Reason: ${reason}`;
        this.terminateTrade(message);
    }

    private async onMultysigData(data: any): Promise<any> {
        if (!data.msData || !data.listenerPubkey || !data.listenerAddress) this.terminateTrade(`No pubKey or MultysigData Received`);
        this.multysigData = data.msData;
        this.log(`Received PubKey: ${data.listenerPubkey}`);
        this.listenerPubkey = data.listenerPubkey;
        this.listenerAddress = data.listenerAddress;
        const pubKeysArray = [this.listenerPubkey, this.receiverPubkey];
        const amaRes: ApiRes = await this.client("addmultisigaddress", 2, pubKeysArray);
        if (amaRes.error || !amaRes.data) return this.terminateTrade(amaRes.error);
        if (amaRes.data.redeemScript !== data.msData.redeemScript) return this.terminateTrade(`redeemScript of Multysig address is not matching`);
        this.multysigData = amaRes.data;
        this.socket.emit(emmitEvents.COMMIT_TO_CHANNEL);
    }

    private onSignedRawTx(rawTx: string) {
        this.readyRes({ data: rawTx });
    }

    protected async getBestBlock(n: number) {
        const bbhRes = await this.client('getbestblockhash');
        if (bbhRes.error || !bbhRes.data) return null;
        const bbRes = await this.client('getblock', bbhRes.data);
        if (bbRes.error || !bbRes.data?.height) return null;
        const height = bbRes.data.height + n;
        return height;
    }
}