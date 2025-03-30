import { Socket as SocketClient } from 'socket.io-client';
import { IBuildLTCITTxConfig, IBuildTxConfig, IUTXO, TxsService } from "src/app/@core/services/txs.service";
import { IMSChannelData, SwapEvent, IBuyerSellerInfo, TClient, IFuturesTradeProps, ISpotTradeProps, ETradeType } from "./common";
import { Swap } from "./swap";
import { ENCODER } from '../payloads/encoder';
import { ToastrService } from "ngx-toastr";

export class BuySwapper extends Swap {
    private tradeStartTime: number;

    constructor(
        typeTrade: ETradeType,
        tradeInfo: IFuturesTradeProps | ISpotTradeProps, 
        buyerInfo: IBuyerSellerInfo,
        sellerInfo: IBuyerSellerInfo,
        client: TClient,
        socket: SocketClient,
        txsService: TxsService,
        private toastrService: ToastrService
    ) {
        super(typeTrade, tradeInfo, buyerInfo, sellerInfo, client, socket, txsService);
        this.handleOnEvents();
        this.tradeStartTime = Date.now();
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
                    this.onTerminateTrade?.bind(this)(socketId, data);
                    break;
                case 'SELLER:STEP1':
                    this.onStep1?.bind(this)(socketId, data);
                    break;
                case 'SELLER:STEP3':
                    this.onStep3?.bind(this)(socketId, data);
                    break;
                case 'SELLER:STEP5':
                    this.onStep5?.bind(this)(socketId, data);
                    break;
            }
        });
    }

    private async onStep1(cpId: string, msData: IMSChannelData) {
        try {
            if (cpId !== this.cpInfo.socketId) throw new Error(`Error with p2p connection`);
            let pubKeys = [this.cpInfo.keypair.pubkey, this.myInfo.keypair.pubkey];
            if (this.typeTrade === ETradeType.SPOT && 'propIdDesired' in this.tradeInfo) {
                const { propIdDesired, propIdForSale } = this.tradeInfo;
                if (propIdDesired === 0 || propIdForSale === 0) {
                    pubKeys = [this.myInfo.keypair.pubkey, this.cpInfo.keypair.pubkey];
                }
            }

            const amaRes = await this.client("addmultisigaddress", [2, pubKeys]);
            if (amaRes.error) throw new Error(`addmultisigaddress: ${amaRes.error}`);
            if (amaRes.data.redeemScript !== msData.redeemScript) throw new Error(`redeemScript of Multisig is not matching`);
            this.multySigChannelData = msData;
            console.log('this multisig ' + JSON.stringify(this.multySigChannelData));
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
        const bbData = parseFloat(gbcRes.data) + 10;
        console.log('examing this.tradeInfo object '+JSON.stringify(this.tradeInfo))
        // Preserve the ctcpParams logic based on trade type
        if (this.typeTrade === ETradeType.SPOT && 'propIdDesired' in this.tradeInfo) {
            let { propIdDesired, amountDesired, amountForSale, propIdForSale, transfer } = this.tradeInfo
            
            const column = await this.txsService.predictColumn(this.myInfo.keypair.address, this.cpInfo.keypair.address);
                    let isA = column === 'A' ? 1 : 0;

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
                    console.log('sats paid? '+satsPaid+' '+ltcForSale+' '+amountDesired+' '+amountForSale)
                const payload = ENCODER.encodeTradeTokenForUTXO({
                    propertyId: tokenId,
                    amount: tokensSold,
                    columnA: isA === 1,
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

                console.log('build options in LTC trade '+JSON.stringify(buildOptions))
                const rawHexRes = await this.txsService.buildLTCITTx(buildOptions);
                if (rawHexRes.error || !rawHexRes.data?.psbtHex) throw new Error(`Build Trade: ${rawHexRes.error}`);
                const swapEvent = new SwapEvent('BUYER:STEP4', this.myInfo.socketId, rawHexRes.data.psbtHex);
                this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
            } else {
                let payload;
                if (transfer) {
                    payload = ENCODER.encodeTransfer({
                        propertyId: propIdForSale,
                        amount: amountForSale,
                        isColumnA: isA ===1,  // Assume Column A, adjust based on context
                        destinationAddr: this.multySigChannelData.address,
                    });
                } else{
                    payload = ENCODER.encodeCommit({
                        amount: amountForSale,
                        propertyId: propIdForSale,
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
                        propertyId1: propIdForSale,
                        propertyId2: propIdDesired,
                        amountOffered1: amountForSale,
                        amountDesired2: amountDesired,
                        columnAIsOfferer: isA,
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
                    console.log('build options in ltc trade step 3 '+JSON.stringify(buildOptions))
                    const rawHexRes = await this.txsService.buildLTCITTx(buildOptions);
                    if (rawHexRes.error || !rawHexRes.data?.psbtHex) throw new Error(`Build Trade: ${rawHexRes.error}`);

                    const swapEvent = new SwapEvent('BUYER:STEP4', this.myInfo.socketId, rawHexRes.data.psbtHex);
                    this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
            }

        } else if (this.typeTrade === ETradeType.FUTURES && 'contract_id' in this.tradeInfo) {
    throw new Error(`Futures is not supported for now`);

    const { contract_id, amount, price } = this.tradeInfo as IFuturesTradeProps;

    if (!this.multySigChannelData) throw new Error('Missing multisig channel data');
    if (!this.multySigChannelData?.address) throw new Error('Multisig address is undefined');

    const ctcpParams = [contract_id, amount.toString()];
    const cpctcRes = await this.client('tl_createpayload_commit_tochannel', ctcpParams);
    if (cpctcRes.error || !cpctcRes.data) throw new Error(`tl_createpayload_commit_tochannel: ${cpctcRes.error}`);

    const fromKeyPair = { address: this.myInfo.keypair.address };
    const toKeyPair = { address: this.multySigChannelData!.address };
    const payload = cpctcRes.data;

    const commitTxConfig: IBuildTxConfig = { fromKeyPair, toKeyPair, payload };
    const commitTxRes = await this.txsService.buildTx(commitTxConfig);
    if (commitTxRes.error || !commitTxRes.data) throw new Error(`Build Commit TX: ${commitTxRes.error}`);

    const commitTxData = commitTxRes.data!;
    const { inputs, rawtx } = commitTxData;

    const wifRes = await this.txsService.getWifByAddress(this.myInfo.keypair.address);
    if (wifRes.error || typeof wifRes.data !== 'string') throw new Error(`Invalid WIF: ${wifRes.error}`);
    const wif = wifRes.data;

    const cimmitTxSignRes = await this.txsService.signTx({ rawtx, inputs, wif });
    if (cimmitTxSignRes.error || !cimmitTxSignRes.data) throw new Error(`Sign Commit TX: ${cimmitTxSignRes.error}`);

    const signData = cimmitTxSignRes.data!;
    const { isValid: finalValid, signedHex: finalSignedHex } = signData;
    if (!finalValid || !finalSignedHex) throw new Error(`Sign Commit TX (2): ${cimmitTxSignRes.error}`);

    if (!finalSignedHex) throw new Error('Signed hex is undefined');
    const commiTxSendRes = await this.txsService.sendTx(finalSignedHex!);

    if (commiTxSendRes.error || !commiTxSendRes.data) throw new Error(`Send Commit TX: ${commiTxSendRes.error}`);

    const drtRes = await this.client("decoderawtransaction", [rawtx]);
    if (drtRes.error || !drtRes.data?.vout) throw new Error(`decoderawtransaction: ${drtRes.error}`);

    const vout = drtRes.data.vout.find((o: any) =>
        o.scriptPubKey?.addresses?.[0] === this.multySigChannelData!.address
    );
    if (!vout) throw new Error(`decoderawtransaction (2): ${drtRes.error}`);

    const scriptPubKey = this.multySigChannelData?.scriptPubKey;
    const redeemScript = this.multySigChannelData?.redeemScript;
    if (!scriptPubKey || !redeemScript) throw new Error('Missing scriptPubKey or redeemScript');

    const utxoData: IUTXO = {
        amount: vout.value,
        vout: vout.n,
        txid: commiTxSendRes.data,
        scriptPubKey: scriptPubKey || '',
        redeemScript,
        confirmations: 0
    };

    const cpcitOptions = [contract_id, amount.toString(), bbData, price.toString(), 1, "1"];
    const cpcitRes = await this.client('tl_createpayload_contract_instant_trade', cpcitOptions);
    if (cpcitRes.error || !cpcitRes.data) throw new Error(`tl_createpayload_contract_instant_trade: ${cpcitRes.error}`);

    const buildOptions: IBuildLTCITTxConfig = {
        buyerKeyPair: this.myInfo.keypair,
        sellerKeyPair: this.cpInfo.keypair,
        commitUTXOs: [commitUTXO, utxoData],
        payload: cpcitRes.data,
        amount: 0,
    };

    const rawHexRes = await this.txsService.buildLTCITTx(buildOptions);
    if (rawHexRes.error || !rawHexRes.data?.psbtHex) throw new Error(`Build Trade: ${rawHexRes.error}`);

    if (!rawHexRes.data?.psbtHex) throw new Error('Missing PSBT hex');
    const psbtHex = rawHexRes.data?.psbtHex;
    if (!psbtHex) throw new Error('Missing PSBT hex');

    const swapEvent = new SwapEvent('BUYER:STEP4', this.myInfo.socketId, psbtHex);
    this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
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

        const wif = wifRes.data;
        if (typeof wif !== 'string') return this.terminateTrade(`Step 5: Invalid WIF type`);

        if (!wif) return this.terminateTrade(`Step 5: getWifByAddress: WIF not found: ${this.myInfo.keypair.address}`);

        const signRes = await this.txsService.signPsbt({ wif, psbtHex });
        if (signRes.error || !signRes.data) return this.terminateTrade(`Step 5: signPsbt: ${signRes.error}`);
        if (!signRes.data.isFinished || !signRes.data.finalHex) return this.terminateTrade(`Step 5: Transaction not Fully Synced`);

        const currentTime = Date.now();
        this.toastrService.info(`Signed! ${currentTime - this.tradeStartTime} ms`);

        await new Promise(resolve => setTimeout(resolve, 1000));

        const finalTxIdRes = await this.txsService.sendTxWithSpecRetry(signRes.data.finalHex);
        if (finalTxIdRes.error || !finalTxIdRes.data) return this.terminateTrade(`Step 5: sendRawTransaction: ${finalTxIdRes.error}`);

        if (this.readyRes) this.readyRes({ data: { txid: finalTxIdRes.data, seller: false, trade: this.tradeInfo } });

        const swapEvent = new SwapEvent('BUYER:STEP6', this.myInfo.socketId, finalTxIdRes.data);
        this.toastrService.info('Trade completed: ' + finalTxIdRes.data);
        this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);

        this.removePreviuesListeners();
    }
}
