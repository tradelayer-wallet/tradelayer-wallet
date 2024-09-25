import { Socket as SocketClient } from 'socket.io-client';
import { IBuildLTCITTxConfig, IBuildTxConfig, IUTXO, TxsService } from "src/app/@core/services/txs.service";
import { IMSChannelData, SwapEvent, IBuyerSellerInfo, TClient, IFuturesTradeProps, ISpotTradeProps, ETradeType } from "./common";
import { Swap } from "./swap";
import { ENCODER } from '../payloads/encoder';
import { ToastrService } from "ngx-toastr";

export class BuySwapper extends Swap {
    private tradeStartTime: number; // Add this declaration for tradeStartTime
    constructor(
        typeTrade: ETradeType,
        tradeInfo: ISpotTradeProps,//IFuturesTradeProps |, 
        buyerInfo: IBuyerSellerInfo,
        sellerInfo: IBuyerSellerInfo,
        client: TClient,
        socket: SocketClient,
        txsService: TxsService,
        private toastrService: ToastrService
    ) {
        super(typeTrade, tradeInfo, buyerInfo, sellerInfo, client, socket, txsService);
        this.handleOnEvents();
        this.tradeStartTime = Date.now(); // Start time of the trade
        this.onReady();
    }

    private logTime(stage: string) {
        const currentTime = Date.now();
        console.log(`Time taken for ${stage}: ${currentTime - this.tradeStartTime} ms`);
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
        this.logTime('Step 3 Start');
    try {
        if (cpId !== this.cpInfo.socketId) throw new Error(`Error with p2p connection`);
        if (!this.multySigChannelData) throw new Error(`Wrong Multisig Data Provided`);

        const gbcRes = await this.client('getblockcount');
        if (gbcRes.error || !gbcRes.data) throw new Error(`Block: ${gbcRes.error}`);
        const bbData = parseFloat(gbcRes.data) + 1000;

        // Preserve the ctcpParams logic based on trade type
        if (this.typeTrade === ETradeType.SPOT && 'propIdDesired' in this.tradeInfo) {
            let { propIdDesired, amountDesired, amountForSale, propIdForSale, transfer } = this.tradeInfo
            //let { transfer } = this.tradeInfo as ITradeInfo<ISpotTradeProps>;
            console.log('importing transfer '+transfer)
            if (transfer == undefined) {
                transfer=false
            }

            let ltcTrade = false;
            let ltcForSale = false;
            if (propIdDesired === 0) {
                ltcTrade = true;
            } else if (propIdForSale === 0) {
                ltcTrade = true;
                ltcForSale = false;
            }

            // Handle Litecoin-based trades
            if (ltcTrade === true) {
                    const cpitLTCOptions = [propIdDesired, amountDesired.toString(), amountForSale.toString(), bbData];
                    let tokenId = ltcForSale ? propIdForSale : propIdDesired;
                    let tokensSold = ltcForSale ? amountForSale : amountDesired;
                    let satsPaid = ltcForSale ? amountDesired : amountForSale;

                    const column = await this.txsService.predictColumn(this.multySigChannelData.address, this.cpInfo.keypair.address);
                    let isA = column === 'A' ? 1 : 0;

                const payload = ENCODER.encodeTradeTokenForUTXO({
                    propertyId: tokenId,
                    amount: tokensSold,
                    columnA: isA,
                    satsExpected: satsPaid,
                    tokenOutput: 0,
                    payToAddress: 1
                });

                const buildOptions: IBuildLTCITTxConfig = {
                    buyerKeyPair: this.myInfo.keypair,
                    sellerKeyPair: this.cpInfo.keypair,
                    commitUTXOs: [commitUTXO],
                    payload: payload,
                    amount: amountForSale,
                };

                const rawHexRes = await this.txsService.buildLTCITTx(buildOptions);
                if (rawHexRes.error || !rawHexRes.data?.psbtHex) throw new Error(`Build Trade: ${rawHexRes.error}`);
                const swapEvent = new SwapEvent('BUYER:STEP4', this.myInfo.socketId, rawHexRes.data.psbtHex);
                this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);

            } else {
                let payload;
                if (transfer) {
                    payload = ENCODER.encodeTransfer({
                        propertyId: propIdDesired,
                        amount: amountDesired,
                        isColumnA: true,  // Assume Column A, adjust based on context
                        destinationAddr: this.multySigChannelData.address,
                    });
                } else{
                    payload = ENCODER.encodeCommit({
                        amount: amountDesired,
                        propertyId: propIdDesired,
                        channelAddress: this.multySigChannelData.address,
                    });
                }

                const commitTxConfig: IBuildTxConfig = {
                    fromKeyPair: { address: this.myInfo.keypair.address },
                    toKeyPair: { address: this.multySigChannelData.address },
                    payload: payload
                };

                const commitTxRes = await this.txsService.buildTx(commitTxConfig);
                if (commitTxRes.error || !commitTxRes.data) throw new Error(`Build Commit TX: ${commitTxRes.error}`);

                  const { rawtx } = commitTxRes.data;
                    const commitTxSignRes = await this.txsService.signRawTxWithWallet(rawtx);
                    if (commitTxSignRes.error || !commitTxSignRes.data) throw new Error(`Sign Commit TX: ${commitTxSignRes.error}`);

                    const signedHex = commitTxSignRes.data?.signedHex;
                    if (!signedHex) throw new Error(`Failed to sign transaction`);

                    const commitTxSendRes = await this.txsService.sendTx(signedHex);
                    if (commitTxSendRes.error || !commitTxSendRes.data) throw new Error(`Failed to send transaction`);

                    // Handle UTXO creation for the next step
                    const drtRes = await this.client("decoderawtransaction", [rawtx]);
                    if (drtRes.error || !drtRes.data?.vout) throw new Error(`decoderawtransaction: ${drtRes.error}`);

                    const vout = drtRes.data.vout.find((o: any) => o.scriptPubKey?.addresses?.[0] === this.multySigChannelData?.address);
                    if (!vout) throw new Error(`decoderawtransaction (2): ${drtRes.error}`);

                    const utxoData = {
                        amount: vout.value,
                        vout: vout.n,
                        txid: commitTxSendRes.data,
                        scriptPubKey: this.multySigChannelData.scriptPubKey,
                        redeemScript: this.multySigChannelData.redeemScript,
                    } as IUTXO;

                    
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
                    const rawHexRes = await this.txsService.buildLTCITTx(buildOptions);
                    if (rawHexRes.error || !rawHexRes.data?.psbtHex) throw new Error(`Build Trade: ${rawHexRes.error}`);

                    const swapEvent = new SwapEvent('BUYER:STEP4', this.myInfo.socketId, rawHexRes.data.psbtHex);
                    this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
            }

        } else if (this.typeTrade === ETradeType.FUTURES && 'contract_id' in this.tradeInfo) {
            throw new Error(`Futures is not supported for now`);

            // Preserved commented-out code related to futures
            
                    // The following is the commented-out block related to futures that is preserved as is
                    /*
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
                    */
        } else {
            throw new Error(`Unrecognized Trade Type: ${this.typeTrade}`);
        }
    } catch (error: any) {
        const errorMessage = error.message || 'Undefined Error';
        this.terminateTrade(`Step 3: ${errorMessage}`);
    }
}


    private async onStep5(cpId: string, psbtHex: string) {
        this.logTime('Step 5 Start');
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Step 5: Error with p2p connection: code 4');
        if (!psbtHex) return this.terminateTrade('Step 5: PsbtHex Not Provided');
        
        const wifRes = await this.txsService.getWifByAddress(this.myInfo.keypair.address);
        if (wifRes.error || !wifRes.data) return this.terminateTrade(`Step 5: getWifByAddress: ${wifRes.error}`);
        console.log('inside step 5 '+JSON.stringify(wifRes))
        const wif = wifRes.data;
        if (!wif) return this.terminateTrade(`Step 5: getWifByAddress: WIF not found: ${this.myInfo.keypair.address}`);
        
        const signRes = await this.txsService.signPsbt({ wif, psbtHex });
        if (signRes.error || !signRes.data) return this.terminateTrade(`Step 5: signPsbt: ${signRes.error}`);
        if (!signRes.data.isFinished || !signRes.data.finalHex) return this.terminateTrade(`Step 5: Transaction not Fully Synced`);

        // Notify user that signing is done and the process will wait for UTXOs to appear in mempool
        this.toastrService.info('Signed! ${currentTime - this.tradeStartTime} ms');

        const maxAttempts = 100;  // Maximum number of checks before timeout
        const delayBetweenChecks = 1000;  // 1 seconds delay between checks
        let attempts = 0;
        let isInMempool = false;
        await new Promise(resolve => setTimeout(resolve, delayBetweenChecks));
        
        /*while (attempts < maxAttempts) {
            isInMempool = await this.txsService.checkMempool(signRes.data.finalHex);
            if (isInMempool) break;

            attempts++;
            await new Promise(resolve => setTimeout(resolve, delayBetweenChecks));
        }*/

        //if (!isInMempool) return this.terminateTrade('Step 5: UTXOs not found in mempool after multiple attempts.');

        const finalTxIdRes = await this.txsService.sendTxWithSpecRetry(signRes.data.finalHex);
        if (finalTxIdRes.error || !finalTxIdRes.data) return this.terminateTrade(`Step 5: sendRawTransaction: ${finalTxIdRes.error}` || `Error with sending Raw Tx`);
        
        if (this.readyRes) this.readyRes({ data: { txid: finalTxIdRes.data, seller: false, trade: this.tradeInfo } });
                
        const swapEvent = new SwapEvent('BUYER:STEP6', this.myInfo.socketId, finalTxIdRes.data);

        this.toastrService.info('Trade completed: '+finalTxIdRes.data);

        this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
        
        this.removePreviuesListeners();
    }

}
