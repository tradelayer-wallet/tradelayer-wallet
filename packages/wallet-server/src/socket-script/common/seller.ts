import { Socket } from 'socket.io-client';
import { ITradeInfo, IUTXOData, MSChannelData, TBuyerSellerInfo, TClient } from "./types";

export class Seller {
    private multySigChannelData: MSChannelData;
    private commitTx: string;
    private utxoData: IUTXOData;
    private readyRes: (value: { data?: any, error?: any }) => void;


    constructor(
        private tradeInfo: ITradeInfo | any, 
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
            setTimeout(() => this.terminateTrade('Undefined Error code 1'), 20000);
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
        const pubKeys = [this.myInfo.pubKey, this.cpInfo.pubKey];
        const amaRes = await this.asyncClient("addmultisigaddress", 2, pubKeys);
        if (amaRes.error || !amaRes.data) return this.terminateTrade(`addmultisigaddress: ${amaRes.error}`);
        this.multySigChannelData = amaRes.data;

        const validateMS = await this.asyncClient("validateaddress", this.multySigChannelData.address);
        if (validateMS.error || !validateMS.data?.scriptPubKey) return this.terminateTrade(`validateaddress: ${validateMS.error}`);
        this.multySigChannelData.scriptPubKey = validateMS.data.scriptPubKey;
        this.socket.emit(`${this.myInfo.socketId}::SELLER:MS_DATA`, this.multySigChannelData);
    }

    private onTerminateTrade(cpId: string, reason: string = 'Undefined Reason') {
        if (this.readyRes) this.readyRes({ error: reason });
        this.removePreviuesListeners();
    }

    private async onCommit(cpId: string) {
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 6');
        await this.setEstimateFee();
        const { contractId, propIdDesired, amountDesired, collateral } = this.tradeInfo;
        const commitData = [
            this.myInfo.address,
            this.multySigChannelData.address,
            contractId ? collateral : propIdDesired,
            (amountDesired).toString(),
        ];
        //api-first update tl_commit_tochannel
        const ctcRes = await this.asyncClient("tl_commit_tochannel", ...commitData);
        if (ctcRes.error || !ctcRes.data) return this.terminateTrade(`tl_commit_tochannel: ${ctcRes.error}`);
        this.commitTx = ctcRes.data;

        //api-first update gettransaction
        const gtRes = await this.asyncClient("gettransaction", this.commitTx);
        if (gtRes.error || !gtRes.data?.hex) return this.terminateTrade(`gettransaction: ${gtRes.error}`);
        const drtRes = await this.asyncClient("decoderawtransaction", gtRes.data.hex);
        if (drtRes.error || !drtRes.data?.vout) return this.terminateTrade(`decoderawtransaction: ${drtRes.error}`);
        const vout = drtRes.data.vout.find((o: any) => o.scriptPubKey?.addresses?.[0] === this.multySigChannelData.address);
        if (!vout) return this.terminateTrade(drtRes.error);
        this.utxoData = {
            amount: vout.value,
            vout: vout.n,
            txid: this.commitTx
        };
        this.socket.emit(`${this.myInfo.socketId}::SELLER:COMMIT_UTXO`, this.utxoData);
    }

    private async onRawTx(cpId: string, data: { rawTx: string, prevTx?: any }) {
        const { rawTx, prevTx } = data;
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 7');
        if (!rawTx) return this.terminateTrade('No RawTx for Signing Provided!');

        const { txid, vout, amount } = this.utxoData;
        const { scriptPubKey, redeemScript } = this.multySigChannelData;

        if (!txid || !vout || !amount || !scriptPubKey || !redeemScript) {
            this.terminateTrade('Error with saved Data');
            return;
        }
        const prevTxsData = { txid, vout, amount, scriptPubKey, redeemScript };
        const prevTxsArray = [prevTxsData];
        if (prevTx) prevTxsArray.push(prevTx);
        const ssrtxRes = await this.asyncClient("signrawtransaction", rawTx, prevTxsArray);
        if (ssrtxRes.error || !ssrtxRes.data?.hex) return this.terminateTrade(`signrawtransaction: ${ssrtxRes.error}` || `Error with Signing Raw TX`);
        this.socket.emit(`${this.myInfo.socketId}::SELLER:SIGNED_RAWTX`, { hex: ssrtxRes.data.hex, prevTxsData });
    }

    private async onFinalTx(cpId: string, finalTx: string) {
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 6');
        if (this.readyRes) this.readyRes({ data: { txid: finalTx, seller: true, trade: this.tradeInfo } });
        this.removePreviuesListeners();
    }

    private async setEstimateFee() {
        // api first update: setestimatefee
        const estimateRes = await this.asyncClient('estimatesmartfee', [1]);
        if (!estimateRes.data?.feerate) {
            return  { error: `Error with Setting Estimate Fee. ${estimateRes?.error || ''} `, data: null };
        }
        const feeRate = parseFloat((parseFloat(estimateRes?.data?.feerate) * 1000).toFixed(8));
        const setFeeRes = await this.asyncClient('settxfee', [feeRate]);
        if (!setFeeRes.data || setFeeRes.error) {
          return { error: `Error with Setting Estimate Fee. ${setFeeRes?.error || ''} `, data: null };
        }
        return setFeeRes;
    }
}