import { io, Socket } from "socket.io-client";
import {
    ApiRes,
    ROptions,
    Trade,
    Events1 as emmitEvents,
    Events2 as onEvents,
} from "../common/types";

export abstract class Receiver {
    protected socket: Socket;
    protected logs: boolean = false;
    protected trade: Trade;

    private listenerChannelPubKey: string;
    private receiverChannelPubKey: string;

    private signedRawTx: string;

    protected multySigChannelData: any;
    protected commitsTx: string[];

    private readyRes: any;
    private readyRej: any;

    private send: boolean;
    constructor(host: string, trade: Trade, options: ROptions, send: boolean) {
        this.send = send;
        this.logs = options.logs;
        this.trade = trade;
        this.init(host);
        this.onReady();
    }

    init(host: string): void {
        // const socketOptions = { 'reconnection': false }
        this.socket = io(host);
        this.socket.on('connect', this.onConnection.bind(this));
    }

    close(): void {
        this.socket.close();
    }

    onReady() {
        return new Promise((res, rej) => {
            this.readyRes = res;
            this.readyRej = rej
        })
    }

    // async sendRawTx() {
    //     this.log(`Start Sending Raw Tx if its readey!`);
    //     if (!this.signedRawTx) return { error: 'There is no Raw TX ready for sending!' };
    //     const srtxRes: ApiRes = await api.sendRawTx(this.signedRawTx);
    //     if (srtxRes.error || !srtxRes.data) return this.terminateTrade(srtxRes.error);
    //     this.log(`Transaction Sended: ${srtxRes.data}`);
    //     return srtxRes;
    // }

    protected log(message: string, data?: any): void {
        if (this.logs) console.log(`${message} ${JSON.stringify(data, null, "\t") || ''}`);
    }

    private onConnection(): void {
        this.log(`Connected`);
        this.handleListeners();
        // this.sendTradeRequest();
    }

    private handleListeners(): void {
        // this.socket.on(onEvents.REJECT_TRADE, this.onTradeReject.bind(this));
        // this.socket.on(onEvents.TERMINATE_TRADE, this.onTradeTerminate.bind(this));
        // this.socket.on(onEvents.CHANNEL_PUB_KEY, this.onChannelPubKey.bind(this));
        // this.socket.on(onEvents.MULTYSIG_DATA, this.onMultisigData.bind(this));
        // this.socket.on(onEvents.SIGNED_RAWTX, this.onSignedRawTx.bind(this))
    }

    // private sendTradeRequest(): void {
    //     this.socket.emit(emmitEvents.TRADE_REQUEST, this.trade);
    // }

    protected terminateTrade(reason: string = 'No info') {
        const error = `Trade Terminated! ${reason}`
        this.log(error);
        if (this.readyRej) this.readyRes({ error })
        this.close();
        return { error };
    }

    // private async legitMultySig(pubKeys: string[], redeemScript: string): Promise<boolean> {
    //     this.log(`Legiting Multysig`);

    //     const amaRes: ApiRes = await api.addMultisigAddress(2, pubKeys);
    //     if (amaRes.error || !amaRes.data) {
    //         this.terminateTrade(amaRes.error);
    //         return false;
    //     }
    //     const legitRedeemScript = amaRes.data.redeemScript;
    //     return redeemScript === legitRedeemScript;
    // }

    //On Methods

    // private onTradeReject(reason: string): void {
    //     const message = `Trade Rejected!! Reason: ${reason}`;
    //     this.terminateTrade(message);
    // }

    // private onTradeTerminate(reason: string): void {
    //     const message = `Trade Terminated!! Reason: ${reason}`;
    //     this.terminateTrade(message);
    // }

    // private async onChannelPubKey(data: any): Promise<any> {
    //     if (!data.pubkey || !data.address) this.terminateTrade(`No pubKey Received`)
    //     this.log(`Received PubKey: ${data.pubkey}`);
    //     this.listenerChannelPubKey = data.pubkey;

    //     this.log(`Creating New Address`);
    //     const gnaRes: ApiRes = await api.getNewAddress();
    //     if (gnaRes.error || !gnaRes.data) return this.terminateTrade(gnaRes.error);
    //     const gnaData = gnaRes.data;
    //     this.log(`Created New Address ${gnaData}`);
  
    //     this.log(`Validating Address`);
    //     const vaResult: ApiRes = await api.validateAddress(gnaData);
    //     if (vaResult.error || !vaResult.data) return this.terminateTrade(vaResult.error);
    //     const vaData = vaResult.data;
    //     this.receiverChannelPubKey = vaData.pubkey;

    //     this.socket.emit(emmitEvents.CHANNEL_PUB_KEY, vaData.pubkey);
    //     this.log(`Valid Address. Pubkey: ${vaData.pubkey}`);
    // }

    // private async onMultisigData(multisigData: any) {
    //     if (!multisigData) this.terminateTrade(`No pubKey Received`)
    //     this.log(`Received MultisigData:`, multisigData);
    //     const pubKeys: string[] = [this.listenerChannelPubKey, this.receiverChannelPubKey]
    //     const isValid: boolean = await this.legitMultySig(pubKeys, multisigData.redeemScript);
    //     this.log(`Received MultySig Address ${isValid ? 'IS' : "IS NOT" } valid!`);
    //     if (!isValid) return this.terminateTrade('Wrong MyltySig Data Provided!');
    //     this.multySigChannelData = multisigData;
    //     this.initTrade();
    // }

    // protected initTrade(): any {
    //     return this.terminateTrade(`Not found Init Function`)
    // }

    // private async onSignedRawTx(rawTx: string): Promise<any> {
    //     if (!rawTx) return this.terminateTrade('No RawTx for Signing Provided!');
    //     this.log(`Received Signed RawTx and start co-signing rawTx: ${rawTx}`);
    //     if (!this.commitsTx || !this.trade) {
    //         return this.readyRes({ error: 'Something Wrong' });
    //     }
    //     this.readyRes({ commits: this.commitsTx, rawTx, trade: this.trade });
    //     return;
    //     const ssrtxRes: ApiRes = await api.simpleSignRawTx(rawTx);
    //     if (ssrtxRes.error || !ssrtxRes.data) return this.terminateTrade(ssrtxRes.error);
    //     if (!ssrtxRes.data.complete || !ssrtxRes.data.hex) return this.terminateTrade(`Error with Signing Raw TX`);
    //     this.log(`Final co-signed Raw TX: ${ ssrtxRes.data.hex}`);
    //     this.signedRawTx = ssrtxRes.data.hex;
    //     this.close();

    //     if(!this.commitsTx || !this.signedRawTx || !this.trade) {
    //         return this.readyRes({ error: 'Something Wrong' });
    //     }
        
    //     if (this.send) {
    //         const srt: ApiRes = await api.sendrawtransaction(this.signedRawTx);
    //         if (srt.error || !srt.data) return this.terminateTrade(srt.error); 
    //         console.log(`Sender Raw TX: ${srt.data}`);

    //         this.readyRes({ commits: this.commitsTx, rawTx: this.signedRawTx, trade: this.trade, tx: srt.data });
    //     } else {
    //         this.readyRes({ commits: this.commitsTx, rawTx: this.signedRawTx, trade: this.trade });
    //     }
    // }

    // protected async listUnspent(address: string) {
    //     this.log(`Getting unspent address: ${address}`)
    //     if (!address) return this.terminateTrade(`Can't Find Address for listunspent`);
    //     const lusRes: ApiRes = await api.listunspent(0, 9999999, [address]);
    //     if (lusRes.error || !lusRes.data) return this.terminateTrade(lusRes.error);
    //     if (lusRes.data.length < 1) return this.terminateTrade(`Not found usnepnds for the address ${address}`);
    //     this.log(`Unspents for multySig Address length: ${lusRes.data.length}`);
    //     return lusRes.data
    // }

    // protected async commitToChannel(commitOptions: any[]) {
    //       const ctcRes: ApiRes = await api.commitToChannel(...commitOptions);
    //       if (ctcRes.error || !ctcRes.data) return this.terminateTrade(ctcRes.error);
    //       this.log(`Commit Channel Tx: ${ctcRes.data}. ID: ${commitOptions[2]}, amount: ${commitOptions[3]}`);
    //       return ctcRes.data;
    // }

    // protected async getBestBlock(n: number) {
    //     this.log(`Getting Best Block`);
    //     const bbRes: ApiRes = await api.getBestBlock();
    //     if (bbRes.error || !bbRes.data || !bbRes.data.height) return this.terminateTrade(bbRes.error || `Error with getting best block`);
    //     const height = bbRes.data.height + n;
    //     this.log(`Best Block: ${bbRes.data.height} - exp.Block : ${height}`);
    //     return height;
    // }
}
