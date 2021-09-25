import { Socket } from 'socket.io-client';
import { RawTx } from './rawtx';
import { ApiRes, IBuildRawTxOptions, IInputs, ITradeInfo, IUTXOData, MSChannelData, TBuyerSellerInfo, TClient } from "./types";

export class Buyer {
    private multySigChannelData: MSChannelData;
    private readyRes: (value: { data?: any, error?: any }) => void;
    private sendCounter = 1

    constructor(
        private tradeInfo: ITradeInfo, 
        private myInfo: TBuyerSellerInfo, 
        private cpInfo: TBuyerSellerInfo,
        private asyncClient: TClient,
        private socket: Socket,
    ) { 
        this.handleOnEvents();
        this.onReady();
    }

    onReady() {
        return new Promise<{ data?: any, error?: any }>((res) => {
            this.readyRes = res;
            setTimeout(() => this.terminateTrade('Undefined Error :('), 9000);
        });
    }

    private terminateTrade(reason: string = 'No info'): void {
        this.socket.emit(`${this.myInfo.socketId}::TERMINATE_TRADE`, reason);
        this.onTerminateTrade('', reason);
    }

    private removePreviuesListeners() {
        const eventsArray = ['TERMINATE_TRADE', 'SELLER:MS_DATA', 'SELLER:COMMIT_UTXO', 'SELLER:SIGNED_RAWTX'];
        eventsArray.forEach(e => this.socket.off(`${this.cpInfo.socketId}::${e}`));
    }

    private handleOnEvents() {
        this.removePreviuesListeners();

        this.socket.on(`${this.cpInfo.socketId}::TERMINATE_TRADE`, this.onTerminateTrade.bind(this));
        this.socket.on(`${this.cpInfo.socketId}::SELLER:MS_DATA`, this.onMSData.bind(this));
        this.socket.on(`${this.cpInfo.socketId}::SELLER:COMMIT_UTXO`, this.onCommitUTXO.bind(this));
        this.socket.on(`${this.cpInfo.socketId}::SELLER:SIGNED_RAWTX`, this.onSignedRawTx.bind(this));
    }
    
    private onTerminateTrade(cpId: string, reason: string = 'Undefined Reason') {
        if (this.readyRes) this.readyRes({ error: reason });
        this.removePreviuesListeners();
    }

    private async onMSData(cpId: string, msData: MSChannelData) {
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 2');
        const pubKeys = [this.cpInfo.pubKey, this.myInfo.pubKey];
        const amaRes = await this.asyncClient("addmultisigaddress", 2, pubKeys);
        if (amaRes.error || !amaRes.data) return this.terminateTrade(amaRes.error);
        if (amaRes.data.redeemScript !== msData.redeemScript) return this.terminateTrade(`redeemScript of Multysig address is not matching`);
        this.multySigChannelData = msData;
        this.socket.emit(`${this.myInfo.socketId}::BUYER:COMMIT`);
    }

    private async onCommitUTXO(cpId: string, commitUTXO: IUTXOData) {
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 3');
        const { scriptPubKey, redeemScript } = this.multySigChannelData;
        if (!scriptPubKey || !redeemScript) return this.terminateTrade('Error with getting multysig channel data');
        const commitInput: IInputs = { ...commitUTXO,  scriptPubKey, redeemScript };

        const propIdForSale = this.tradeInfo.propIdForSale;
        if (propIdForSale === 999) {
            const rawHex = await this.buildLTCInstantTrade(commitInput);
            if (rawHex.error || !rawHex.data) return this.terminateTrade(rawHex.error || `Error with Buildng Trade`);
            this.socket.emit(`${this.myInfo.socketId}::BUYER:RAWTX`, rawHex.data);
        } else {
            return this.terminateTrade(`Not a LTC INSTANT TRADE`);
            const rawHex = await this.buildTTTrade(commitInput);
            if (rawHex.error || !rawHex.data) return this.terminateTrade(rawHex.error || `Error with Buildng Trade`);
            this.socket.emit(`${this.myInfo.socketId}::BUYER:RAWTX`, rawHex.data);
        }
    }

    private async onSignedRawTx(cpId: string, rawTxObj: { hex: string, prevTxsData: any }) {
        const { hex, prevTxsData } = rawTxObj;
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 4');
        if (!hex) return this.terminateTrade('RawTx Not Provided');
        const ssrtxRes = await this.asyncClient("signrawtransaction", hex, [prevTxsData]);
        if (ssrtxRes.error || !ssrtxRes.data?.hex || !ssrtxRes.data?.complete) return this.terminateTrade(ssrtxRes.error || `Error with Signing Raw TX`);
        const finalTxIdRes = await this.sendRawTransaction(ssrtxRes.data.hex);
        if (finalTxIdRes.error || !finalTxIdRes.data) return this.terminateTrade(finalTxIdRes.error || `Error with sending Raw Tx`);

        if (this.readyRes) this.readyRes({ data: { txid: finalTxIdRes.data, seller: false, trade: this.tradeInfo } });
        this.socket.emit(`${this.myInfo.socketId}::BUYER:FINALTX`, finalTxIdRes.data);
        this.removePreviuesListeners();
    }

    private async sendRawTransaction(hex: string) {
        this.sendCounter++;
        await new Promise(res => setTimeout(() => res(true), 500));
        const result = await this.asyncClient("sendrawtransaction", hex);
        if (result.error || !result.data) {
            return this.sendCounter < 15
                 ? await this.sendRawTransaction(hex)
                 : result;
        }
        return result;
    }

    private async buildTTTrade(commitUTXO: IInputs) {
        try {
            const { vout, amount, txid } = commitUTXO;
            if (!vout || !amount || !txid)  return { error: 'Error Provided Commit Data' };
    
            const bbData: number = await this.getBestBlock(10);
            if (!bbData) return { error: `Error with getting best block, ${bbData}` };
    
                        // ---------------------------------------
                        const commitData = [        
                            this.myInfo.address,
                            this.multySigChannelData.address,
                            this.tradeInfo.propIdForSale,
                            this.tradeInfo.amountForSale,
                        ];
                        const ctcRes = await this.asyncClient("tl_commit_tochannel", ...commitData);
                        const ctcErrorMessage = `Error with Commiting tokens to channel`;
                        if (ctcRes.error || !ctcRes.data) return { error: ctcRes.error || ctcErrorMessage };

                        const commitUTXO2 = {} as IInputs;
                        // -------------------------
                        
            const { propIdDesired, amountDesired, propIdForSale, amountForSale } = this.tradeInfo;
            const cpitLTCOptions = [ propIdForSale, amountForSale, propIdDesired, amountDesired, bbData ];
            const cpitRes = await this.asyncClient('tl_createpayload_instant_trade', ...cpitLTCOptions);
            if (cpitRes.error || !cpitRes.data) return { error: cpitRes.error || `Error with creating payload` };


            const rawTxOptions: IBuildRawTxOptions = {
                fromAddress: this.myInfo.address,
                toAddress: this.cpInfo.address,
                payload: cpitRes.data,
                inputs: [commitUTXO, commitUTXO2],
            };
            const ltcIt = new RawTx(rawTxOptions, this.asyncClient);
            const bLTCit = await ltcIt.build();
            if (bLTCit.error || !bLTCit.data) return { error: bLTCit.error || `Error with Building LTC Instat Trade` };
            return { data: bLTCit.data };

        } catch (error) {
            return { error: error.message }
        }

    }

    private async buildLTCInstantTrade(commitUTXO: IInputs) {
        try {
            const { vout, amount, txid } = commitUTXO;
            if (!vout || !amount || !txid)  return { error: 'Error Provided Commit Data' };
    
            const bbData: number = await this.getBestBlock(10);
            if (!bbData) return { error: `Error with getting best block, ${bbData}` };
    
            const { propIdDesired, amountDesired, amountForSale } = this.tradeInfo;
            const cpitLTCOptions = [ propIdDesired, amountDesired, amountForSale, bbData ];
            const cpitRes = await this.asyncClient('tl_createpayload_instant_ltc_trade', ...cpitLTCOptions);
            if (cpitRes.error || !cpitRes.data) return { error: cpitRes.error || `Error with creating payload` };
            const rawTxOptions: IBuildRawTxOptions = {
                fromAddress: this.myInfo.address,
                toAddress: this.cpInfo.address,
                payload: cpitRes.data,
                inputs: [commitUTXO],
                refAddressAmount: parseFloat(amountForSale),
            };
            const ltcIt = new RawTx(rawTxOptions, this.asyncClient);
            const bLTCit = await ltcIt.build();
            if (bLTCit.error || !bLTCit.data) return { error: bLTCit.error || `Error with Building LTC Instat Trade` };
            return { data: bLTCit.data };
        } catch (error) {
            return { error: error.message }
        }
    }


    private async getBestBlock(n: number) {
        const bbhRes = await this.asyncClient('getbestblockhash');
        if (bbhRes.error || !bbhRes.data) return null;
        const bbRes = await this.asyncClient('getblock', bbhRes.data);
        if (bbRes.error || !bbRes.data?.height) return null;
        const height = bbRes.data.height + n;
        return height;
    }
}