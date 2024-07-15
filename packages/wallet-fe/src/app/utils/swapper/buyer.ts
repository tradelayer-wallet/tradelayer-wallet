import { Socket as SocketClient } from 'socket.io-client';
import { IBuildLTCITTxConfig, IBuildTxConfig, IUTXO, TxsService } from "src/app/@core/services/txs.service";
import { IMSChannelData, SwapEvent, IBuyerSellerInfo, TClient, IFuturesTradeProps, ISpotTradeProps, ETradeType } from "./common";
import { Swap } from "./swap";
import { ENCODER } from '../payloads/encoder';

export class BuySwapper extends Swap {
    constructor(
        typeTrade: ETradeType,
        tradeInfo: IFuturesTradeProps | ISpotTradeProps, 
        buyerInfo: IBuyerSellerInfo,
        sellerInfo: IBuyerSellerInfo,
        client: TClient,
        socket: SocketClient,
        txsService: TxsService,
    ) {
        super(typeTrade, tradeInfo, buyerInfo, sellerInfo, client, socket, txsService);
        this.handleOnEvents();
        this.onReady();
    }

    private handleOnEvents() {
        this.removePreviuesListeners();
        const _eventName = `${this.cpInfo.socketId}::swap`;
        this.socket.on(_eventName, (eventData: SwapEvent) => {
            const { socketId, data } = eventData;
            this.eventSubs$.next(eventData);
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
        try {
            if (cpId !== this.cpInfo.socketId) throw new Error(`Error with p2p connection`);
            const pubKeys = [this.cpInfo.keypair.pubkey, this.myInfo.keypair.pubkey];
            const amaRes = await this.client("addmultisigaddress", [2, pubKeys]);
            if (amaRes.error || !amaRes.data) throw new Error(`addmultisigaddress: ${amaRes.error}`);
            if (amaRes.data.redeemScript !== msData.redeemScript) throw new Error(`redeemScript of Multysig is not matching`);
            this.multySigChannelData = msData;
            const swapEvent = new SwapEvent('BUYER:STEP2', this.myInfo.socketId);
            this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
        } catch (error: any) {
            const errorMessge = error.message || 'Undefined Error';
            this.terminateTrade(`Step 1: ${errorMessge}`);
        }
    }

    private async onStep3(cpId: string, commitUTXO: IUTXO) {
        try {
            if (cpId !== this.cpInfo.socketId) throw new Error(`Error with p2p connection`);
            if (!this.multySigChannelData) throw new Error(`Wrong Multisig Data Provided`);
            const gbcRes = await this.client('getblockcount');
            if (gbcRes.error || !gbcRes.data) throw new Error(`Block: ${gbcRes.error}`);
            const bbData = gbcRes.data.block + 1000;
            if (this.typeTrade === ETradeType.SPOT && 'propIdDesired' in this.tradeInfo) {
                const { propIdDesired, amountDesired, amountForSale, propIdForSale } = this.tradeInfo;

                if (propIdForSale === -1) {
                    throw new Error(`Litecoin is not supported for now`);
                    // const cpitLTCOptions = [ propIdDesired, (amountDesired).toString(), (amountForSale).toString(), bbData ];
                    // const cpitRes = await this.client('tl_createpayload_instant_ltc_trade', cpitLTCOptions);
                    // if (cpitRes.error || !cpitRes.data) throw new Error(`tl_createpayload_instant_ltc_trade: ${cpitRes.error}`);
                    // const buildOptions: IBuildLTCITTxConfig = {
                    //     buyerKeyPair: this.myInfo.keypair,
                    //     sellerKeyPair: this.cpInfo.keypair,
                    //     commitUTXOs: [commitUTXO],
                    //     payload: cpitRes.data,
                    //     amount: amountForSale,
                    // };
                    // const rawHexRes = await this.txsService.buildLTCITTx(buildOptions);
                    // if (rawHexRes.error || !rawHexRes.data?.psbtHex) throw new Error(`Build Trade: ${rawHexRes.error}`);
                    // const swapEvent = new SwapEvent('BUYER:STEP4', this.myInfo.socketId, rawHexRes.data.psbtHex);
                    // this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
                } else {
                    // const ctcpParams = [propIdDesired, (amountDesired).toString()];
                    // const cpctcRes = await this.client('tl_createpayload_commit_tochannel', ctcpParams);
                    // if (cpctcRes.error || !cpctcRes.data) throw new Error(`tl_createpayload_commit_tochannel: ${cpctcRes.error}`);
                    
                    const fromKeyPair = { address: this.myInfo.keypair.address };
                    const toKeyPair = { address: this.multySigChannelData.address };
                    // const payload = cpctcRes.data;
                    const payload = ENCODER.encodeCommit({
                        amount: this.tradeInfo.amountDesired,
                        propertyId: this.tradeInfo.propIdDesired,
                        channelAddress: this.multySigChannelData.address,
                    });
                    console.log({ payload })
                    const commitTxConfig: IBuildTxConfig = { fromKeyPair, toKeyPair, payload };
            
                    // build Commit Tx
                    const commitTxRes = await this.txsService.buildTx(commitTxConfig);
                    console.log({ commitTxRes });
                    if (commitTxRes.error || !commitTxRes.data) throw new Error(`Build Commit TX: ${commitTxRes.error}`);
                    const { inputs, rawtx } = commitTxRes.data;
                    // const wif = this.txsService.getWifByAddress(this.myInfo.keypair.address);
                    // if (!wif) throw new Error(`WIF not found: ${this.myInfo.keypair.address}`);
                    
                    // sign Commit Tx
                    // const cimmitTxSignRes = await this.txsService.signTx({ rawtx, inputs, wif });
                    const cimmitTxSignRes = await this.txsService.signRawTxWithWallet(rawtx);
                    console.log({ cimmitTxSignRes });
                    if (cimmitTxSignRes.error || !cimmitTxSignRes.data) throw new Error(`Sign Commit TX: ${cimmitTxSignRes.error}`);
                    const { isValid, signedHex } = cimmitTxSignRes.data;
                    if (!isValid || !signedHex) throw new Error(`Sign Commit TX (2): ${cimmitTxSignRes.error}`);
    
                    // send Commit Tx
                    const commiTxSendRes = await this.txsService.sendTx(signedHex);
                    console.log({ commiTxSendRes });
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
        
                    console.log({ utxoData })
                    // const cpitLTCOptions = [ propIdDesired, (amountDesired).toString(), propIdForSale, (amountForSale).toString(), bbData ];
                    // const cpitRes = await this.client('tl_createpayload_instant_trade', cpitLTCOptions);

                    const cpitLTCOptions = {
                        propertyId1: propIdDesired,
                        propertyId2: propIdForSale,
                        amountOffered1: amountForSale,
                        amountDesired2: amountForSale,
                        columnAIsOfferer: true,
                        expiryBlock: bbData,
                    }
                    const cpitRes = { data: ENCODER.encodeTradeTokensChannel(cpitLTCOptions), error: null };
                    if (cpitRes.error || !cpitRes.data) throw new Error(`tl_createpayload_instant_trade: ${cpitRes.error}`);
                    const buildOptions: IBuildLTCITTxConfig = {
                        buyerKeyPair: this.myInfo.keypair,
                        sellerKeyPair: this.cpInfo.keypair,
                        commitUTXOs: [commitUTXO, utxoData],
                        payload: cpitRes.data,
                        amount: 0,
                    };
                    console.log({ buildOptions });
                    const rawHexRes = await this.txsService.buildLTCITTx(buildOptions);
                    console.log({ rawHexRes })
                    if (rawHexRes.error || !rawHexRes.data?.psbtHex) throw new Error(`Build Trade: ${rawHexRes.error}`);
                    const swapEvent = new SwapEvent('BUYER:STEP4', this.myInfo.socketId, rawHexRes.data.psbtHex);
                    this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
                }
            } else if (this.typeTrade === ETradeType.FUTURES && 'contract_id' in this.tradeInfo) {
                throw new Error(`Futures is not supported for now`);
                // const { contract_id, amount, price, } = this.tradeInfo;
                // const ctcpParams = [contract_id, (amount).toString()];
                // const cpctcRes = await this.client('tl_createpayload_commit_tochannel', ctcpParams);
                // if (cpctcRes.error || !cpctcRes.data) throw new Error(`tl_createpayload_commit_tochannel: ${cpctcRes.error}`);
                
                // const fromKeyPair = { address: this.myInfo.keypair.address };
                // const toKeyPair = { address: this.multySigChannelData.address };
                // const payload = cpctcRes.data;
                // const commitTxConfig: IBuildTxConfig = { fromKeyPair, toKeyPair, payload };
        
                // // build Commit Tx
                // const commitTxRes = await this.txsService.buildTx(commitTxConfig);
                // if (commitTxRes.error || !commitTxRes.data) throw new Error(`Build Commit TX: ${commitTxRes.error}`);
                // const { inputs, rawtx } = commitTxRes.data;
                // const wif = this.txsService.getWifByAddress(this.myInfo.keypair.address);
                // if (!wif) throw new Error(`WIF not found: ${this.myInfo.keypair.address}`);
                
                // // sign Commit Tx
                // const cimmitTxSignRes = await this.txsService.signTx({ rawtx, inputs, wif });
                // if (cimmitTxSignRes.error || !cimmitTxSignRes.data) throw new Error(`Sign Commit TX: ${cimmitTxSignRes.error}`);
                // const { isValid, signedHex } = cimmitTxSignRes.data;
                // if (!isValid || !signedHex) throw new Error(`Sign Commit TX (2): ${cimmitTxSignRes.error}`);

                // // send Commit Tx
                // const commiTxSendRes = await this.txsService.sendTx(signedHex);
                // if (commiTxSendRes.error || !commiTxSendRes.data) throw new Error(`Send Commit TX: ${commiTxSendRes.error}`);
    
                // //
                // const drtRes = await this.client("decoderawtransaction", [rawtx]);
                // if (drtRes.error || !drtRes.data?.vout) throw new Error(`decoderawtransaction: ${drtRes.error}`);
                // const vout = drtRes.data.vout.find((o: any) => o.scriptPubKey?.addresses?.[0] === this.multySigChannelData?.address);
                // if (!vout) throw new Error(`decoderawtransaction (2): ${drtRes.error}`);
                // const utxoData = {
                //     amount: vout.value,
                //     vout: vout.n,
                //     txid: commiTxSendRes.data,
                //     scriptPubKey: this.multySigChannelData.scriptPubKey,
                //     redeemScript: this.multySigChannelData.redeemScript,
                // } as IUTXO;
                // // contractid, amount, height, price, action(buy), leverage
                // const cpcitOptions = [ contract_id, (amount).toString(), bbData, (price).toString(), 1, "1" ];
                // const cpcitRes = await this.client('tl_createpayload_contract_instant_trade', cpcitOptions);
                // if (cpcitRes.error || !cpcitRes.data) throw new Error(`tl_createpayload_contract_instant_trade: ${cpcitRes.error}`);
                // const buildOptions: IBuildLTCITTxConfig = {
                //     buyerKeyPair: this.myInfo.keypair,
                //     sellerKeyPair: this.cpInfo.keypair,
                //     commitUTXOs: [commitUTXO, utxoData],
                //     payload: cpcitRes.data,
                //     amount: 0,
                // };
                // const rawHexRes = await this.txsService.buildLTCITTx(buildOptions);
                // if (rawHexRes.error || !rawHexRes.data?.psbtHex) throw new Error(`Build Trade: ${rawHexRes.error}`);
                // const swapEvent = new SwapEvent('BUYER:STEP4', this.myInfo.socketId, rawHexRes.data.psbtHex);
                // this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
            } else {
                throw new Error(`Unrecognized Trade Type: ${this.typeTrade}`);
            }
        } catch (error: any) {
            const errorMessge = error.message || 'Undefined Error';
            this.terminateTrade(`Step 3: ${errorMessge}`);
        }
    }

    private async onStep5(cpId: string, psbtHex: string) {
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Step 5: Error with p2p connection: code 4');
        if (!psbtHex) return this.terminateTrade('Step 5: PsbtHex Not Provided');
        const wif = this.txsService.getWifByAddress(this.myInfo.keypair.address);
        if (!wif) return this.terminateTrade(`Step 5: getWifByAddress: WIF not found: ${this.myInfo.keypair.address}`);
        const signRes = await this.txsService.signPsbt({ wif, psbtHex });
        console.log({ signRes })
        if (signRes.error || !signRes.data) return this.terminateTrade(`Step 5: signPsbt: ${signRes.error}`);
        if (!signRes.data.isFinished || !signRes.data.finalHex) return this.terminateTrade(`Step 5: Transaction not Full Synced`);
        const finalTxIdRes = await this.txsService.sendTx(signRes.data.finalHex);
        console.log({ finalTxIdRes });
        if (finalTxIdRes.error || !finalTxIdRes.data) return this.terminateTrade(`Step 5: sendRawTransaction: ${finalTxIdRes.error}` || `Error with sending Raw Tx`);
        if (this.readyRes) this.readyRes({ data: { txid: finalTxIdRes.data, seller: false, trade: this.tradeInfo } });
        const swapEvent = new SwapEvent('BUYER:STEP6', this.myInfo.socketId, finalTxIdRes.data);
        this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
        this.removePreviuesListeners();
    }
}
