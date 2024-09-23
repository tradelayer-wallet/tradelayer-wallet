import { Socket as SocketClient } from 'socket.io-client';
import { IBuildTxConfig, IUTXO, TxsService } from "src/app/@core/services/txs.service";
import { IMSChannelData, SwapEvent, IBuyerSellerInfo, TClient, IFuturesTradeProps, ISpotTradeProps, ETradeType } from "./common";
import { Swap } from "./swap";
import { ENCODER } from '../payloads/encoder';
import { ToastrService } from "ngx-toastr";

export class SellSwapper extends Swap {
    constructor(
        typeTrade: ETradeType,
        tradeInfo: ISpotTradeProps|IFuturesTradeProps,
        sellerInfo: IBuyerSellerInfo,
        buyerInfo: IBuyerSellerInfo,
        client: TClient,
        socket: SocketClient,
        txsService: TxsService,
        private toastrService: ToastrService
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
            this.multySigChannelData = amaRes.data as IMSChannelData;

            const validateMS = await this.client("validateaddress", [this.multySigChannelData.address]);
            if (validateMS.error || !validateMS.data?.scriptPubKey) throw new Error(`Init Trade: validateaddress: ${validateMS.error}`);
            this.multySigChannelData.scriptPubKey = validateMS.data.scriptPubKey;

            const swapEvent = new SwapEvent(`SELLER:STEP1`, this.myInfo.socketId, this.multySigChannelData);
            this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
        } catch (error: any) {
            const errorMessage = error.message || 'Undefined Error';
            this.terminateTrade(`InitTrade: ${errorMessage}`);
        }
    }

    private async onStep2(cpId: string) {
        try {
            if (!this.multySigChannelData?.address) throw new Error(`Error with finding Multisig Address`);
            if (cpId !== this.cpInfo.socketId) throw new Error(`Error with p2p connection`);

            const fromKeyPair = { address: this.myInfo.keypair.address };
            const toKeyPair = { address: this.multySigChannelData.address };
            const commitTxConfig: IBuildTxConfig = { fromKeyPair, toKeyPair };

            let { propIdDesired, amountDesired, transfer } = this.tradeInfo;
            let { spotProps } = this.tradeInfo as ITradeInfo<ISpotTradeProps>;
            let { transfer} = props 
            console.log('importing transfer '+transfer)
            if (transfer == undefined) {
                transfer = false
            }

            const column = await this.txsService.predictColumn(this.myInfo.keypair.address, this.cpInfo.keypair.address);
            const isColumnA = column === 'A';

            console.log('inside step 2 '+ propIdDesired+' '+amountDesired +' '+transfer+' '+column+' '+isColumnA)
            // Check if channel balance can cover the trade amount
            if (transfer) {
                console.log('Using channel balance for transfer');

                const transferPayload = ENCODER.encodeTransfer({
                    propertyId: propIdDesired,
                    amount: amountDesired,
                    isColumnA: isColumnA,
                    destinationAddr: this.multySigChannelData.address,
                });

                commitTxConfig.payload = transferPayload;
            }else if(!transfer){
                 console.log('Using available balance for trade');

                const commitPayload = ENCODER.encodeCommit({
                    amount: amountDesired,
                    propertyId: propIdDesired,
                    channelAddress: this.multySigChannelData.address,
                });

                commitTxConfig.payload = commitPayload;
            }

                const transferTxRes = await this.txsService.buildTx(commitTxConfig);
                if (transferTxRes.error || !transferTxRes.data) throw new Error(`Build Transfer TX: ${transferTxRes.error}`);

                const { rawtx } = transferTxRes.data;
                const signTransferTxRes = await this.txsService.signRawTxWithWallet(rawtx);
                if (signTransferTxRes.error || !signTransferTxRes.data?.signedHex) throw new Error(`Sign Transfer TX: ${signTransferTxRes.error}`);

                // Only call sendTx if signedHex is defined
                const signedHex = signTransferTxRes.data.signedHex;
                let sendTransferTxRes
                if (signedHex) {
                    sendTransferTxRes = await this.txsService.sendTx(signedHex);
                    if (sendTransferTxRes.error || !sendTransferTxRes.data) throw new Error(`Send Transfer TX: ${sendTransferTxRes.error}`);
                    console.log(`Transfer TX sent with txid: ${sendTransferTxRes.data}`);
                } else {
                    throw new Error('Signed Hex is undefined for Transfer TX');
                }
                  const drtRes = await this.client("decoderawtransaction", [rawtx]);
                    if (drtRes.error || !drtRes.data?.vout) throw new Error(`decoderawtransaction: ${drtRes.error}`);
                    const vout = drtRes.data.vout.find((o: any) => o.scriptPubKey?.addresses?.[0] === this.multySigChannelData?.address);
                    if (!vout) throw new Error(`decoderawtransaction (2): ${drtRes.error}`);
                    const utxoData = {
                        amount: vout.value,
                        vout: vout.n,
                        txid: sendTransferTxRes.data,
                        scriptPubKey: this.multySigChannelData.scriptPubKey,
                        redeemScript: this.multySigChannelData.redeemScript,
                    } as IUTXO;

                    const swapEvent = new SwapEvent(`SELLER:STEP3`, this.myInfo.socketId, utxoData);
                    this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
        } catch (error: any) {
            const errorMessage = error.message || 'Undefined Error';
            this.terminateTrade(`Step 2: ${errorMessage}`);
        }
    }

    private async onStep4(cpId: string, psbtHex: string) {
        try {
            if (cpId !== this.cpInfo.socketId) return console.log(`Error with p2p connection`);
            if (!psbtHex) throw new Error(`PsbtHex for syncing not provided`);

            const wifRes = await this.txsService.getWifByAddress(this.myInfo.keypair.address);
            console.log('inside step 4 '+JSON.stringify(wifRes)+' '+JSON.stringify(psbtHex))
            if (wifRes.error || !wifRes.data) return console.log(`WIF not found: ${this.myInfo.keypair.address}`);

            const signRes = await this.txsService.signPsbt({ wif: wifRes.data, psbtHex });
            console.log('cosign '+JSON.stringify(signRes))
            if (signRes.error || !signRes.data?.psbtHex) return console.log(`Sign Tx: ${signRes.error}`);

            const swapEvent = new SwapEvent(`SELLER:STEP5`, this.myInfo.socketId, signRes.data.psbtHex);
            this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
        } catch (error: any) {
            const errorMessage = error.message || 'Undefined Error';
            this.terminateTrade(`Step 4: ${errorMessage}`);
        }
    }

    private async onStep6(cpId: string, finalTx: string) {
        try {
            if (cpId !== this.cpInfo.socketId) throw new Error(`Error with p2p connection`);

            const data = { txid: finalTx, seller: true, trade: this.tradeInfo };
            this.readyRes({ data });
            this.removePreviuesListeners();
        } catch (error: any) {
            const errorMessage = error.message || 'Undefined Error';
            this.terminateTrade(`Step 6: ${errorMessage}`);
        }
    }
}
