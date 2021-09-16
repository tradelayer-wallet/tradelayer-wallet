import { Socket } from 'socket.io-client';
import { ITradeInfo, IUTXOData, MSChannelData, TBuyerSellerInfo, TClient } from "./types";

export class Seller {
    private multySigChannelData: MSChannelData;
    private commitTx: string;
    private utxoData: IUTXOData;
    private readyRes: (value: { data?: any, error?: any }) => void;


    constructor(
        private tradeInfo: ITradeInfo, 
        private myInfo: TBuyerSellerInfo, 
        private cpInfo: TBuyerSellerInfo,
        private asyncClient: TClient,
        private socket: Socket,
    ) { 
        this.handleOnEvents();
        this.initTrade();
        this.onReady();
    } 

    onReady() {
        return new Promise<{ data?: any, error?: any }>((res) => {
            this.readyRes = res;
        });
    }

    private terminateTrade(reason: string = 'No info'): void {
        this.socket.emit(`${this.myInfo.socketId}::TERMINATE_TRADE`, reason);
        this.onTerminateTrade('', reason);
    }

    private removePreviuesListeners() {
        const eventsArray = ['TERMINATE_TRADE', 'BUYER:COMMIT', 'BUYER:RAWTX', 'BUYER:FINALTX' ];
        eventsArray.forEach(e => this.socket.off(`${this.cpInfo.socketId}::${e}`));
    }

    private handleOnEvents() {
        this.removePreviuesListeners();
        this.socket.on(`${this.cpInfo.socketId}::TERMINATE_TRADE`, this.onTerminateTrade.bind(this));
        this.socket.on(`${this.cpInfo.socketId}::BUYER:COMMIT`, this.onCommit.bind(this));
        this.socket.on(`${this.cpInfo.socketId}::BUYER:RAWTX`, this.onRawTx.bind(this));
        this.socket.on(`${this.cpInfo.socketId}::BUYER:FINALTX`, this.onFinalTx.bind(this));
    }

    private async initTrade() {
        console.log(`InitTrade!`);
        if (this.tradeInfo.propIdForSale !== 999) return this.terminateTrade('The wallet dont Support this type of trade!');
        const pubKeys = [this.myInfo.pubKey, this.cpInfo.pubKey];
        const amaRes = await this.asyncClient("addmultisigaddress", 2, pubKeys);
        if (amaRes.error || !amaRes.data) return this.terminateTrade(amaRes.error);
        this.multySigChannelData = amaRes.data;

        const validateMS = await this.asyncClient("validateaddress", this.multySigChannelData.address);
        if (validateMS.error || !validateMS.data?.scriptPubKey) return this.terminateTrade(validateMS.error);
        this.multySigChannelData.scriptPubKey = validateMS.data.scriptPubKey;
        this.socket.emit(`${this.myInfo.socketId}::SELLER:MS_DATA`, this.multySigChannelData);
    }

    private onTerminateTrade(cpId: string, reason: string = 'Undefined Reason') {
        console.log(`TRADE TERMINATED! REASON: ${reason}`);
        if (this.readyRes) this.readyRes({ error: reason });
        this.removePreviuesListeners();
    }

    private async onCommit(cpId: string) {
        console.log(`OnCommit from ${cpId}`);
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 6');
        if (this.tradeInfo.propIdForSale !== 999) return this.terminateTrade('The wallet dont Support this type of trade!');

        const commitData = [        
            this.myInfo.address,
            this.multySigChannelData.address,
            this.tradeInfo.propIdDesired,
            this.tradeInfo.amountDesired,
        ];
        const ctcRes = await this.asyncClient("tl_commit_tochannel", ...commitData);
        if (ctcRes.error || !ctcRes.data) return this.terminateTrade(ctcRes.error);
        this.commitTx = ctcRes.data;

        const gtRes = await this.asyncClient("gettransaction", this.commitTx);
        if (gtRes.error || !gtRes.data?.hex) return this.terminateTrade(gtRes.error);
        const drtRes = await this.asyncClient("decoderawtransaction", gtRes.data.hex);
        if (drtRes.error || !drtRes.data?.vout) return this.terminateTrade(drtRes.error);
        const vout = drtRes.data.vout.find((o: any) => o.scriptPubKey?.addresses?.[0] === this.multySigChannelData.address);
        if (!vout) return this.terminateTrade(drtRes.error);
        this.utxoData = {
            amount: vout.value,
            vout: vout.n,
            txid: this.commitTx
        };
        this.socket.emit(`${this.myInfo.socketId}::SELLER:COMMIT_UTXO`, this.utxoData);
    }

    private async onRawTx(cpId: string, rawTx: string) {
        console.log(`OnRawTx form ${cpId}`);
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 7');
        if (!rawTx) return this.terminateTrade('No RawTx for Signing Provided!');

        const { txid, vout, amount } = this.utxoData;
        const { scriptPubKey, redeemScript } = this.multySigChannelData;

        if (!txid || !vout || !amount || !scriptPubKey || !redeemScript) {
            this.terminateTrade('Error with saved Data');
            return;
        }
        const prevTxsData = { txid, vout, amount, scriptPubKey, redeemScript };
        const ssrtxRes = await this.asyncClient("signrawtransaction", rawTx, [prevTxsData]);
        console.log(2)
        console.log({ssrtxRes, error: ssrtxRes.data.errors })
        if (ssrtxRes.error || !ssrtxRes.data?.hex) return this.terminateTrade(ssrtxRes.error || `Error with Signing Raw TX`);
        this.socket.emit(`${this.myInfo.socketId}::SELLER:SIGNED_RAWTX`, { hex: ssrtxRes.data.hex, prevTxsData });
    }

    private async onFinalTx(cpId: string, finalTx: string) {
        console.log({finalTx})
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 6');
        if (this.readyRes) this.readyRes({ data: { txid: finalTx, seller: true, trade: this.tradeInfo } });
        this.removePreviuesListeners();
    }
}