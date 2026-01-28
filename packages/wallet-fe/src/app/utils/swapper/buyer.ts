import { Socket as SocketClient } from 'socket.io-client';
import { IBuildLTCITTxConfig, IBuildTxConfig, IUTXO, TxsService } from "src/app/@core/services/txs.service";
import { IMSChannelData, SwapEvent, IBuyerSellerInfo, TClient, IFuturesTradeProps, ISpotTradeProps, ETradeType } from "./common";
import { Swap } from "./swap";
import { ENCODER } from '../payloads/encoder';
import { ToastrService } from "ngx-toastr";
import BigNumber from 'bignumber.js';

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
        private toastrService: ToastrService,
        tradeUUID: string
    ) {
        super(typeTrade, tradeInfo, buyerInfo, sellerInfo, client, socket, txsService,tradeUUID);
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
            console.log('event name '+_eventName+' swap event '+JSON.stringify(eventData))
            const { socketId, data } = eventData;
            this.eventSubs$.next(eventData);
            if (eventData.data?.tradeUUID && eventData.data.tradeUUID !== this.tradeUUID){
                return;
            }

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
            const amaRes = await this.txsService.computeMultisig(2, pubKeys);
            console.log('multisig generated '+JSON.stringify(amaRes))
            //const amaRes = await this.client("addmultisigaddress", [2, pubKeys]);
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
        if (this.typeTrade === ETradeType.SPOT && 'propIdDesired' in this.tradeInfo){
            let { propIdDesired, amountDesired, amountForSale, propIdForSale, transfer, sellerIsMaker} = this.tradeInfo
            
            const column = await this.txsService.predictColumn(this.multySigChannelData.address,this.myInfo.keypair.address, this.cpInfo.keypair.address);
                    let isA = column === 'A' ? 0 : 1;
            const columnAIsMaker = (isA === 1)
            ? (sellerIsMaker ? 1 : 0)     // seller is A
            : (!sellerIsMaker ? 1 : 0);   // seller is B

            console.log('column isA'+isA +' '+column)
            //let { transfer } = this.tradeInfo as ITradeInfo<ISpotTradeProps>;
            console.log('importing transfer '+transfer)
            if (transfer == undefined) {
                transfer=false
            }

            // Handle Litecoin-based trades
            if (propIdDesired==0||propIdForSale==0) {
                    const cpitLTCOptions = [propIdDesired, amountDesired.toString(), amountForSale.toString(), bbData];
                    let tokenId = propIdForSale;
                    let tokensSold = amountForSale
                    let satsPaid = amountDesired
                    console.log('sats paid? '+satsPaid+' '+' '+amountDesired+' '+amountForSale)
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

                console.log('build options in LTC trade '+JSON.stringify(buildOptions))
                const rawHexRes = await this.txsService.buildLTCITTx(buildOptions);
                if (rawHexRes.error || !rawHexRes.data?.psbtHex) throw new Error(`Build Trade: ${rawHexRes.error}`);

                const swapEvent = new SwapEvent('BUYER:STEP4', this.myInfo.socketId,{psbtHex:rawHexRes.data.psbtHex});
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

              
                    const cpitLTCOptions = {
                        propertyId1: propIdForSale,
                        propertyId2: propIdDesired,
                        amountOffered1: amountForSale,
                        amountDesired2: amountDesired,
                        expiryBlock: bbData,
                        columnAIsOfferer: isA,
                        columnAIsMaker
                    }
                    const cpitRes = { data: ENCODER.encodeTradeTokensChannel(cpitLTCOptions), error: null };
                    if (cpitRes.error || !cpitRes.data) throw new Error(`tl_createpayload_instant_trade: ${cpitRes.error}`);
                    const buildOptions: IBuildLTCITTxConfig = {
                        buyerKeyPair: this.myInfo.keypair,
                        sellerKeyPair: this.cpInfo.keypair,
                        commitUTXOs: [commitUTXO],
                        payload: cpitRes.data,
                        amount: 0,
                    };
                    console.log('build options in ltc trade step 3 '+JSON.stringify(buildOptions))
                    const rawHexRes = await this.txsService.buildLTCITTx(buildOptions);
                    if (rawHexRes.error || !rawHexRes.data?.psbtHex) throw new Error(`Build Trade: ${rawHexRes.error}`);

                const commitTxId = commitTxSendRes.data;  

                this.socket.emit(
                  `${this.myInfo.socketId}::swap`,
                  {
                    eventName: 'BUYER:STEP4',
                    socketId:  this.myInfo.socketId,
                    data: {
                      psbtHex: rawHexRes.data.psbtHex,
                      commitHex: signedHex,
                      commitTxId
                    }
                  } as any
                );
            }
       } else if (this.typeTrade === ETradeType.FUTURES && 'contract_id' in this.tradeInfo) {// 1) Unpack your trade info
        const { contract_id, amount, price, transfer = false,sellerIsMaker } = this.tradeInfo as IFuturesTradeProps;
        
        const {initMargin, collateral} = await this.txsService.computeMargin(contract_id,amount,price)

        console.log(' futures trade props '+contract_id +' '+ amount+' '+price+' '+ initMargin+' '+collateral+' '+transfer)


        console.log('about to predict column' +this.multySigChannelData.address+' '+this.myInfo.keypair.address+' '+this.cpInfo.keypair.address)

        // 2) Compute initial margin
        const column = await this.txsService.predictColumn(
          this.multySigChannelData.address,
          this.myInfo.keypair.address,
          this.cpInfo.keypair.address
        );
        const isA = column === 'A' ? 1 : 0;
        console.log('column isA'+isA +' '+column)
        
        let columnAIsMaker = isA === 1 ? (sellerIsMaker ? 1 : 0)   // seller is A
                                      : (!sellerIsMaker ? 1 : 0); // seller is B

        // 3) Build the commit or transfer payload
        const payload = transfer
          ? ENCODER.encodeTransfer({
              propertyId: collateral,
              amount: initMargin,
              isColumnA: isA === 1,
              destinationAddr: this.multySigChannelData.address
            })
          : ENCODER.encodeCommit({
              propertyId: collateral,
              amount: initMargin,
              channelAddress: this.multySigChannelData.address
            });

        // 4) Build the commit TX
        console.log('multySigChannelData:', JSON.stringify(this.multySigChannelData)+' '+JSON.stringify(this.myInfo.keypair.address));
        const commitRes = await this.txsService.buildTx({
          fromKeyPair: { address: this.myInfo.keypair.address },
          toKeyPair: { address: this.multySigChannelData.address },
          payload
        });
        if (commitRes.error || !commitRes.data) {
          throw new Error(`Build Commit TX: ${commitRes.error}`);
        }
        const { rawtx } = commitRes.data;

        // 5) Sign and send the commit TX
        const commitTxSignRes = await this.txsService.signRawTxWithWallet(rawtx);
        if (commitTxSignRes.error || !commitTxSignRes.data) {
          throw new Error(`Sign Commit TX: ${commitTxSignRes.error}`);
        }
        const signedHex = commitTxSignRes.data.signedHex;
        if (!signedHex) throw new Error(`Failed to sign transaction`);

        const commitTxSendRes = await this.txsService.sendTx(signedHex);
        if (commitTxSendRes.error || !commitTxSendRes.data) {
          throw new Error(`Failed to send transaction`);
        }
        const commitTxId = commitTxSendRes.data;

        // 6) Decode raw TX to extract channel-locked UTXO
        const drtRes = await this.client("decoderawtransaction", [rawtx]);
        if (drtRes.error || !drtRes.data?.vout) {
          throw new Error(`decoderawtransaction: ${drtRes.error}`);
        }
        const vout = drtRes.data.vout.find((o: any) =>
          o.scriptPubKey?.addresses?.includes(this.multySigChannelData?.address || '')
        );
        if (!vout) {
          throw new Error(`decoderawtransaction (2): ${drtRes.error}`);
        }
        const commitUTXO: IUTXO = {
          amount: vout.value,
          vout: vout.n,
          txid: commitTxId,
          scriptPubKey: this.multySigChannelData.scriptPubKey || "",
          redeemScript: this.multySigChannelData.redeemScript,
          confirmations:0
        };

        // 7) Encode trade payload
        const channelPayload = ENCODER.encodeTradeContractChannel({
          contractId: contract_id,
          amount,
          expiryBlock: bbData,
          price,
          columnAIsSeller: isA,
          insurance: false,
          columnAIsMaker
        });

        // 8) Build PSBT channel trade TX
         const buildOptions: IBuildLTCITTxConfig = {
                        buyerKeyPair: this.myInfo.keypair,
                        sellerKeyPair: this.cpInfo.keypair,
                        commitUTXOs: [commitUTXO],
                        payload: channelPayload,
                        amount: 0,
                    };
                    console.log('build options in ltc trade step 3 '+JSON.stringify(buildOptions))
                    const rawHexRes = await this.txsService.buildLTCITTx(buildOptions);
        const psbtHex = rawHexRes.data?.psbtHex;

        // 9) Emit BUYER:STEP4 with psbt + commit txid
        const swapEvent = new SwapEvent('BUYER:STEP4', this.myInfo.socketId, {
          psbtHex,
          commitTxId: commitTxId
        });
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
        if (signRes.error || !signRes.data) {
          return this.terminateTrade(`Step 5: signPsbt: ${signRes.error}`);
        }

        const { psbtHex: signedPsbtHex } = signRes.data;
        let finalHex: string | undefined = signRes.data.finalHex;
        console.log('signed res '+JSON.stringify(signRes))
        // Try to finalize if finalHex is missing
        if (!finalHex && signedPsbtHex) {
          const fin = await this.txsService.finalizePsbt?.(signedPsbtHex);
          console.log('finalized '+JSON.stringify(fin))
          finalHex = fin?.data?.finalHex;

        }

        if (!finalHex) {
          return this.terminateTrade('Step 5: missing finalHex after signing/finalize');
        }

        await new Promise(r => setTimeout(r, 1000));
        console.log('signed result', JSON.stringify(signRes));

        const finalTxIdRes = await this.txsService.sendTxWithSpecRetry(finalHex);

        const swapEvent = new SwapEvent('BUYER:STEP6', this.myInfo.socketId, finalTxIdRes.data);
        this.toastrService.info('Trade completed: ' + finalTxIdRes.data);
        this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);

        this.removePreviuesListeners();
    }
}
