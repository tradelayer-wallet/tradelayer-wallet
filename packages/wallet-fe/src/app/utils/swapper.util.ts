import { Socket as SocketClient } from 'socket.io-client';
import { IBuildTxConfig, IUTXO, TxsService } from '../@core/services/txs.service';

class SwapEvent {
    constructor(
        public eventName: string,
        public socketId: string,
        public data: any = null,
    ) {}
}

type TClient = (method: string, ...args: any[]) => Promise<{
    data?: any;
    error?: string;
}>;

export interface ITradeInfo {
    amountDesired: number;
    amountForSale: number;
    propIdDesired: number;
    propIdForSale: number;
}

interface IMSChannelData {
    address: string;
    redeemScript: string;
    scriptPubKey?: string;
}

interface TBuyerSellerInfo {
    address: string;
    pubKey: string;
    socketId: string;
}

abstract class Swap {
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
            setTimeout(() => this.terminateTrade('Undefined Error code 1'), 20000);
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

export class BuySwapper extends Swap {
    constructor(
        tradeInfo: ITradeInfo, 
        buyerInfo: TBuyerSellerInfo,
        sellerInfo: TBuyerSellerInfo,
        client: TClient,
        socket: SocketClient,
        txsService: TxsService,
    ) {
        super(tradeInfo, buyerInfo, sellerInfo, client, socket, txsService);
        this.handleOnEvents();
        this.onReady();
    }

    private handleOnEvents() {
        this.removePreviuesListeners();
        this.socket.on(`${this.cpInfo.socketId}::swap`, (eventData: SwapEvent) => {
            const { socketId, data } = eventData;
            switch (eventData.eventName) {
                case 'TERMINATE_TRADE':
                    this.onTerminateTrade.bind(this)(socketId, data);
                    break;
                case 'SELLER:STEP1':
                    this.onStep1.bind(this)(socketId, data);
                    break;
                case 'SELLER:STEP3':
                    this.onStep3.bind(this)(socketId, data);
                    break;
                case 'SELLER:STEP5':
                    this.onStep5.bind(this)(socketId, data);
                    break;
                default:
                    break;
            }
        });
    }

    private async onStep1(cpId: string, msData: IMSChannelData) {
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 2');
        const pubKeys = [this.cpInfo.pubKey, this.myInfo.pubKey];
        const amaRes = await this.client("addmultisigaddress", [2, pubKeys]);
        if (amaRes.error || !amaRes.data) return this.terminateTrade(`addmultisigaddress: ${amaRes.error}`);
        if (amaRes.data.redeemScript !== msData.redeemScript) return this.terminateTrade(`redeemScript of Multysig address is not matching`);
        this.multySigChannelData = msData;
        const swapEvent = new SwapEvent('BUYER:STEP2', this.myInfo.socketId);
        this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
    }

    private async onStep3(cpId: string, commitUTXO: IUTXO) {
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Step3: Error with p2p connection: code 3');
        if (!this.multySigChannelData) return  this.terminateTrade('Step3: Error getting Multisig Data');
        const tlgiRes = await this.client('tl_getinfo');
        if (tlgiRes.error || !tlgiRes.data?.block) return this.terminateTrade(`Step3: Getinfo: ${tlgiRes.error}`);
        const bbData = tlgiRes.data.block + 100;
        const { propIdDesired, amountDesired, amountForSale, propIdForSale } = this.tradeInfo;
        const cpitLTCOptions = [ propIdDesired, (amountDesired).toString(), (amountForSale).toString(), bbData ];
        const cpitRes = await this.client('tl_createpayload_instant_ltc_trade', cpitLTCOptions);
        if (cpitRes.error || !cpitRes.data) return this.terminateTrade(`Step3: get Payload: ${cpitRes.error}`);
        if (propIdForSale === -1) {
            const buildOptions = {
                fromAddress: this.myInfo.address,
                toAddress: this.cpInfo.address,
                inputs: [commitUTXO],
                payload: cpitRes.data,
                amount: amountForSale,
            }
            const rawHexRes = await this.txsService.buildTx(buildOptions);
            if (rawHexRes.error || !rawHexRes.data?.rawtx) return this.terminateTrade(`Step3: build Trade: ${cpitRes.error}`);
            const step4Data = { rawtx: rawHexRes.data.rawtx, prevTxs: rawHexRes.data.inputs };
            const swapEvent = new SwapEvent('BUYER:STEP4', this.myInfo.socketId, step4Data);
            this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
        } else {
            return this.terminateTrade(`Token-Token Trade is not allowed}`);
        }
    }

    private async onStep5(cpId: string, data: { halfSignedHex: string, prevTxs: IUTXO[], rawtx: string }) {
        const { halfSignedHex, prevTxs, rawtx } = data;
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 4');
        if (!halfSignedHex) return this.terminateTrade('RawTx Not Provided');

        const wif = this.txsService.getWifByAddress(this.myInfo.address);
        if (!wif) return this.terminateTrade(`getWifByAddress: WIF not found: ${this.myInfo.address}`);
        const signRes = await this.txsService.signTx({ wif, inputs: prevTxs, rawtx, halfSignedHex });
        if (signRes.error || !signRes.data?.isValid) return this.terminateTrade(`Step5 signTx: ${signRes.error}`);
        console.log({signRes})
        const finalTxIdRes = await this.txsService.sendTx(signRes.data.signedHex);
        if (finalTxIdRes.error || !finalTxIdRes.data) {
            return this.terminateTrade(`sendRawTransaction: ${finalTxIdRes.error}` || `Error with sending Raw Tx`);
        }

        if (this.readyRes) this.readyRes({ data: { txid: finalTxIdRes.data, seller: false, trade: this.tradeInfo } });

        const swapEvent = new SwapEvent('BUYER:STEP6', this.myInfo.socketId, finalTxIdRes.data);
        this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
        this.removePreviuesListeners();
    }
}

export class SellSwapper extends Swap {
    constructor(
        tradeInfo: ITradeInfo, 
        sellerInfo: TBuyerSellerInfo,
        buyerInfo: TBuyerSellerInfo,
        client: TClient,
        socket: SocketClient,
        txsService: TxsService,
    ) {
        super(tradeInfo, sellerInfo, buyerInfo, client, socket, txsService);
        this.handleOnEvents();
        this.onReady();
        this.initTrade();
    }

    private handleOnEvents() {
        this.removePreviuesListeners();
        const _eventName = `${this.cpInfo.socketId}::swap`;
        this.socket.on(_eventName, (eventData: SwapEvent) => {
            const { socketId, data } = eventData;
            switch (eventData.eventName) {
                case 'TERMINATE_TRADE':
                    this.onTerminateTrade.bind(this)(socketId, data);
                    break;
                case 'BUYER:STEP2':
                    this.onStep2.bind(this)(socketId);
                    break;
                case 'BUYER:STEP4':
                    this.onStep4.bind(this)(socketId, data);
                    break;
                case 'BUYER:STEP6':
                    this.onStep6.bind(this)(socketId, data);
                    break;
                default:
                    break;
            }
        });
    }

    private async initTrade() {
        const pubKeys = [this.myInfo.pubKey, this.cpInfo.pubKey];
        const amaRes = await this.client("addmultisigaddress", [2, pubKeys]);
        if (amaRes.error || !amaRes.data) return this.terminateTrade(`addmultisigaddress: ${amaRes.error}`);
        this.multySigChannelData = (amaRes.data as IMSChannelData);
        const validateMS = await this.client("validateaddress", [this.multySigChannelData.address]);
        if (validateMS.error || !validateMS.data?.scriptPubKey) return this.terminateTrade(`validateaddress: ${validateMS.error}`);
        this.multySigChannelData.scriptPubKey = validateMS.data.scriptPubKey;
        const swapEvent = new SwapEvent(`SELLER:STEP1`, this.myInfo.socketId, this.multySigChannelData);
        this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
    }

    private async onStep2(cpId: string) {
        if (!this.multySigChannelData?.address) return this.terminateTrade('Error with finding Multisig Address');;
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 6');
        const { propIdDesired, amountDesired } = this.tradeInfo;
        const ctcpParams = [propIdDesired, (amountDesired).toString()];
        const cpctcRes = await this.client('tl_createpayload_commit_tochannel', ctcpParams);
        if (cpctcRes.error || !cpctcRes.data) return this.terminateTrade(`tl_createpayload_commit_tochannel: ${cpctcRes.error}`);
        const commitTxConfig: IBuildTxConfig = {
            fromAddress: this.myInfo.address,
            toAddress: this.multySigChannelData?.address,
            payload: cpctcRes.data,
        };

        const commitTxRes = await this.txsService.buildTx(commitTxConfig);
        if (commitTxRes.error || !commitTxRes.data) return this.terminateTrade(`buildTx: ${commitTxRes.error}`);
        const { inputs, rawtx } = commitTxRes.data;
        const wif = this.txsService.getWifByAddress(this.myInfo.address);
        if (!wif)  return this.terminateTrade(`getWifByAddress: WIF not found: ${this.myInfo.address}`);
        const cimmitTxSignRes = await this.txsService.signTx({ rawtx, inputs, wif });
        if (cimmitTxSignRes.error || !cimmitTxSignRes.data?.isValid) return this.terminateTrade(`signCommitTx: ${commitTxRes.error}`);
        const signedTx = cimmitTxSignRes.data.signedHex;
        const commiTxSendRes = await this.txsService.sendTx(signedTx);
        if (commiTxSendRes.error || !commiTxSendRes.data) return this.terminateTrade(`SendCommitTX: ${commiTxSendRes.error}`);
        const commitTx = commiTxSendRes.data;

        const drtRes = await this.client("decoderawtransaction", [rawtx]);
        if (drtRes.error || !drtRes.data?.vout) return this.terminateTrade(`decoderawtransaction: ${drtRes.error}`);
        const vout = drtRes.data.vout.find((o: any) => o.scriptPubKey?.addresses?.[0] === this.multySigChannelData?.address);
        if (!vout) return this.terminateTrade(drtRes.error);
        const utxoData = {
            amount: vout.value,
            vout: vout.n,
            txid: commitTx,
            scriptPubKey: this.multySigChannelData.scriptPubKey,
            redeemScript: this.multySigChannelData.redeemScript,
        };
        const swapEvent = new SwapEvent(`SELLER:STEP3`, this.myInfo.socketId, utxoData);
        this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
    }

    private async onStep4(cpId: string, data: { rawtx: string, prevTxs: IUTXO[] }) {
        const { rawtx, prevTxs } = data;
        console.log({ cpId, rawtx, prevTxs });
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 7');
        if (!rawtx) return this.terminateTrade('No RawTx for Signing Provided!');
          const wif = this.txsService.getWifByAddress(this.myInfo.address);
        if (!wif) return this.terminateTrade(`getWifByAddress: WIF not found: ${this.myInfo.address}`);
        const signRes = await this.txsService.signTx({ wif, inputs: prevTxs, rawtx });
        if (signRes.error || !signRes.data) return this.terminateTrade(`Step4 signTx: ${signRes.error}`);
        const step5Data = { halfSignedHex: signRes.data.signedHex, prevTxs, rawtx };
        const swapEvent = new SwapEvent(`SELLER:STEP5`, this.myInfo.socketId, step5Data);
        this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
    }

    private async onStep6(cpId: string, finalTx: string) {
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 6');
        if (this.readyRes) this.readyRes({ data: { txid: finalTx, seller: true, trade: this.tradeInfo } });
        this.removePreviuesListeners();
    }
}