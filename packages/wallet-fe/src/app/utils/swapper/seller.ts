import { Socket as SocketClient } from 'socket.io-client';
import { IBuildTxConfig, IUTXO, TxsService } from "src/app/@core/services/txs.service";
import { IMSChannelData, SwapEvent, IBuyerSellerInfo, TClient, IFuturesTradeProps, ISpotTradeProps, ETradeType } from "./common";
import { Swap } from "./swap";
import { ENCODER } from '../payloads/encoder';

export class SellSwapper extends Swap {
    constructor(
        typeTrade: ETradeType,
        tradeInfo: IFuturesTradeProps | ISpotTradeProps, 
        sellerInfo: IBuyerSellerInfo,
        buyerInfo: IBuyerSellerInfo,
        client: TClient,
        socket: SocketClient,
        txsService: TxsService,
    ) {
        super(typeTrade, tradeInfo, sellerInfo, buyerInfo, client, socket, txsService);
        this.handleOnEvents();
        this.onReady();
        this.initTrade();
    }

    private handleOnEvents() {
        this.removePreviuesListeners();
        const _eventName = `${this.cpInfo.socketId}::swap`;
        this.socket.on(_eventName, (eventData: SwapEvent) => {
            this.eventSubs$.next(eventData);
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
        try {
            const pubKeys = [this.myInfo.keypair.pubkey, this.cpInfo.keypair.pubkey];

            const amaRes = await this.client("addmultisigaddress", [2, pubKeys]);
            if (amaRes.error || !amaRes.data) throw new Error(`addmultisigaddress: ${amaRes.error}`);
            this.multySigChannelData = (amaRes.data as IMSChannelData);

            const validateMS = await this.client("validateaddress", [this.multySigChannelData.address]);
            if (validateMS.error || !validateMS.data?.scriptPubKey) throw new Error(`Init Trade: validateaddress: ${validateMS.error}`);
            this.multySigChannelData.scriptPubKey = validateMS.data.scriptPubKey;

            const swapEvent = new SwapEvent(`SELLER:STEP1`, this.myInfo.socketId, this.multySigChannelData);
            this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
        } catch (error: any) {
            const errorMessge = error.message || 'Undefined Error';
            this.terminateTrade(`InitTrade: ${errorMessge}`);
        }
    }

    private async onStep2(cpId: string) {
        try {
            if (!this.multySigChannelData?.address) throw new Error(`Error with finding Multisig Address`);
            if (cpId !== this.cpInfo.socketId) throw new Error(`Error with p2p connection`);

            const fromKeyPair = { address: this.myInfo.keypair.address };
            const toKeyPair = { address: this.multySigChannelData.address };
            const commitTxConfig: IBuildTxConfig = { fromKeyPair, toKeyPair };

            const ctcpParams = [];
            if (this.typeTrade === ETradeType.SPOT && 'propIdDesired' in this.tradeInfo) {
                const { propIdDesired, amountDesired } = this.tradeInfo;
                ctcpParams.push(propIdDesired, (amountDesired).toString());
            } else if (this.typeTrade === ETradeType.FUTURES && 'contract_id' in this.tradeInfo) {
                throw new Error(`Futures Trade not implemented yet`);
                // const { amount, collateral } = this.tradeInfo;
                // ctcpParams.push(collateral, (amount).toString());
            } else {
                throw new Error(`Unrecognized Trade Type: ${this.typeTrade}`);
            }
            // const cpctcRes = await this.client('tl_createpayload_commit_tochannel', ctcpParams);
            // if (cpctcRes.error || !cpctcRes.data) throw new Error(`tl_createpayload_commit_tochannel: ${cpctcRes.error}`);

            // const payload = cpctcRes.data;
            const payload = ENCODER.encodeCommit({
                amount: this.tradeInfo.amountDesired,
                propertyId: this.tradeInfo.propIdDesired,
                channelAddress: this.multySigChannelData.address,
            });

            commitTxConfig.payload = payload;
            // build Commit Tx
            const commitTxRes = await this.txsService.buildTx(commitTxConfig);
            if (commitTxRes.error || !commitTxRes.data) throw new Error(`Build Commit TX: ${commitTxRes.error}`);
            const { inputs, rawtx } = commitTxRes.data;
            // const wif = this.txsService.getWifByAddress(this.myInfo.keypair.address);
            // if (!wif) throw new Error(`WIF not found: ${this.myInfo.keypair.address}`);

            // sign Commit Tx
            // const cimmitTxSignRes = await this.txsService.signTx({ rawtx, inputs, wif });
            const commitTxSignRes = await this.txsService.signRawTxWithWallet(rawtx);
            if (commitTxSignRes.error || !commitTxSignRes.data) throw new Error(`Sign Commit TX: ${commitTxSignRes.error}`);
            const { isValid, signedHex } = commitTxSignRes.data;
            if (!isValid || !signedHex) throw new Error(`Sign Commit TX (2): ${commitTxSignRes.error}`);

            // send Commit Tx
            const commiTxSendRes = await this.txsService.sendTx(signedHex);
            if (commiTxSendRes.error || !commiTxSendRes.data) throw new Error(`Send Commit TX: ${commiTxSendRes.error}`);

            // 
            const drtRes = await this.client("decoderawtransaction", [rawtx]);
            if (drtRes.error || !drtRes.data?.vout) throw new Error(`decoderawtransaction: ${drtRes.error}`);
            const vout = drtRes.data.vout.find((o: any) => o.scriptPubKey?.addresses?.[0] === this.multySigChannelData?.address);
            if (!vout) throw new Error(`decoderawtransaction (2): ${drtRes.error}`);
            const utxoData = {
                amount: vout.value,
                vout: vout.n,
                txid: commiTxSendRes.data,
                scriptPubKey: this.multySigChannelData.scriptPubKey,
                redeemScript: this.multySigChannelData.redeemScript,
            } as IUTXO;

            const swapEvent = new SwapEvent(`SELLER:STEP3`, this.myInfo.socketId, utxoData);
            this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
        } catch (error: any) {
            const errorMessge = error.message || 'Undefined Error';
            this.terminateTrade(`Step 2: ${errorMessge}`);
        }
    }

    private async onStep4(cpId: string, psbtHex: string) {
        try {
            if (cpId !== this.cpInfo.socketId) return console.log(`Error with p2p connection`);
            if (!psbtHex) throw new Error(`PsbtHex for syncing not provided`);
            const wifRes = await this.txsService.getWifByAddress(this.myInfo.keypair.address);
            if (wifRes.error || !wifRes.data) return console.log(`WIF not found: ${this.myInfo.keypair.address}`);
            const wif = wifRes.data;
            if (!wif) throw new Error(`WIF not found: ${this.myInfo.keypair.address}`);
            const signRes = await this.txsService.signPsbt({ wif, psbtHex });
            if (signRes.error || !signRes.data?.psbtHex) return console.log(`Sign Tx: ${signRes.error}`);
            const swapEvent = new SwapEvent(`SELLER:STEP5`, this.myInfo.socketId, signRes.data.psbtHex);
            this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
        } catch (error: any) {
            const errorMessge = error.message || 'Undefined Error';
            this.terminateTrade(`Step 4: ${errorMessge}`);
        }
    }

    private async onStep6(cpId: string, finalTx: string) {
        try {
            if (cpId !== this.cpInfo.socketId) throw new Error(`Error with p2p connection`);
            const data = { txid: finalTx, seller: true, trade: this.tradeInfo };
            this.readyRes({ data });
            this.removePreviuesListeners();
        } catch (error: any) {
            const errorMessge = error.message || 'Undefined Error';
            this.terminateTrade(`Step 6: ${errorMessge}`);
        }
    }
}
