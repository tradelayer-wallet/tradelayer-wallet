import { Socket as SocketClient } from 'socket.io-client';
import { IBuildTxConfig, IUTXO, TxsService } from "src/app/@core/services/txs.service";
import { IMSChannelData, SwapEvent, IBuyerSellerInfo, TClient, IFuturesTradeProps, ISpotTradeProps, ETradeType } from "./common";
import { Swap } from "./swap";
import { ENCODER } from '../payloads/encoder';
import { ToastrService } from "ngx-toastr";
import BigNumber from 'bignumber.js';
import { Transaction } from 'bitcoinjs-lib'; 

export class SellSwapper extends Swap {
        private tradeStartTime: number; // Add this declaration for tradeStartTime
    constructor(
        typeTrade: ETradeType,
        tradeInfo: ISpotTradeProps | IFuturesTradeProps,
        sellerInfo: IBuyerSellerInfo,
        buyerInfo: IBuyerSellerInfo,
        client: TClient,
        socket: SocketClient,
        txsService: TxsService,
        private toastrService: ToastrService,
        tradeUUID: string   
    ) {
        super(typeTrade, tradeInfo, sellerInfo, buyerInfo, client, socket, txsService,tradeUUID);
        this.handleOnEvents();
        this.tradeStartTime = Date.now(); // Start time of the trade
        this.onReady();
        this.initTrade();
    }

    
    private logTime(stage: string) {
        const currentTime = Date.now();
        console.log(`Time taken for ${stage}: ${currentTime - this.tradeStartTime} ms`);
    }

    private handleOnEvents() {
        this.removePreviuesListeners();
        const _eventName = `${this.cpInfo.socketId}::swap`;
        console.log(_eventName)
        this.socket.on(_eventName, (eventData: SwapEvent) => {
            this.eventSubs$.next(eventData);
            const { socketId, data } = eventData;
            console.log('event data '+JSON.stringify(eventData))
            if (eventData.data?.tradeUUID && eventData.data.tradeUUID !== this.tradeUUID){
                return;
            }
            switch (eventData.eventName){
                case 'TERMINATE_TRADE':
                    this.onTerminateTrade.bind(this)(socketId, data);
                    break;
                case 'BUYER:STEP2':
                    this.onStep2.bind(this)(socketId);
                    break;
                  case 'BUYER:STEP4':
        const { psbtHex, commitTx } = data as { psbtHex: string; commitTx: string };
                this.onStep4?.bind(this)(socketId, psbtHex, commitTx);
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
            let pubKeys = [this.myInfo.keypair.pubkey, this.cpInfo.keypair.pubkey];
        if (this.typeTrade === ETradeType.SPOT && 'propIdDesired' in this.tradeInfo) {
            let { propIdDesired, propIdForSale} = this.tradeInfo
            if(propIdDesired==0||propIdForSale==0){
                pubKeys = [this.cpInfo.keypair.pubkey,this.myInfo.keypair.pubkey]
            }
        }
            console.log('showing pubkeys before adding multisig '+JSON.stringify(pubKeys))
            const amaRes = await this.client("addmultisigaddress", [2, pubKeys]);
            if (amaRes.error || !amaRes.data) throw new Error(`addmultisigaddress: ${amaRes.error}`);
            this.multySigChannelData = amaRes.data as IMSChannelData;

            const validateMS = await this.client("validateaddress", [this.multySigChannelData.address]);
            if (validateMS.error || !validateMS.data?.scriptPubKey) throw new Error(`Init Trade: validateaddress: ${validateMS.error}`);
            console.log('validateMS return from validateaddress in seller init '+JSON.stringify(validateMS))
            this.multySigChannelData.scriptPubKey = validateMS.data.scriptPubKey;

            const swapEvent = new SwapEvent(`SELLER:STEP1`, this.myInfo.socketId, this.multySigChannelData);
            this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
        } catch (error: any) {
            const errorMessage = error.message || 'Undefined Error';
            this.terminateTrade(`InitTrade: ${errorMessage}`);
        }
    }

   private async onStep2(cpId: string) {
      this.logTime('Step 2 Start');
    //try {
      if (!this.multySigChannelData?.address) {
        throw new Error(`Error with finding Multisig Address`);
      }
      if (cpId !== this.cpInfo.socketId) {
        throw new Error(`Error with p2p connection`);
      }

    const fromKeyPair = { address: this.myInfo.keypair.address };
    const toKeyPair   = { address: this.multySigChannelData.address };
    let payload: string;

    if (this.typeTrade === ETradeType.SPOT && 'propIdDesired' in this.tradeInfo) {
      // ── SPOT ────────────────────────────────────────
      const { propIdDesired, amountDesired, transfer = false } =
        this.tradeInfo as ISpotTradeProps;

      // sanity
      if (propIdDesired == null || amountDesired == null) {
        throw new Error('propIdDesired or amountDesired is undefined');
      }

      payload = transfer
        ? ENCODER.encodeTransfer({
            propertyId:      propIdDesired,
            amount:          amountDesired,
            isColumnA:       await this.txsService.predictColumn(
                                this.multySigChannelData.address,
                                this.myInfo.keypair.address,
                                this.cpInfo.keypair.address
                              ) === 'A',
            destinationAddr: this.multySigChannelData.address,
          })
        : ENCODER.encodeCommit({
            propertyId:     propIdDesired,
            amount:         amountDesired,
            channelAddress: this.multySigChannelData.address,
          });

    } else if (this.typeTrade === ETradeType.FUTURES) {
      // ── FUTURES ───────────────────────────────────────
      const {
        contract_id,
        amount,
        price,
        transfer = false
      } = this.tradeInfo as IFuturesTradeProps;

     const {initMargin, collateral} = await this.txsService.computeMargin(contract_id,amount,price)

      console.log('checking params for commit '+amount + ' '+collateral+' '+initMargin)

      // 2) build appropriate payload
      payload = transfer
        ? ENCODER.encodeTransfer({
            propertyId:      collateral,
            amount:          initMargin,
            isColumnA:       await this.txsService.predictColumn(
                                this.multySigChannelData.address,
                                this.myInfo.keypair.address,
                                this.cpInfo.keypair.address
                              ) === 'A',
            destinationAddr: this.multySigChannelData.address,
          })
        : ENCODER.encodeCommit({
            propertyId:     collateral,
            amount:         initMargin,
            channelAddress: this.multySigChannelData.address,
          });

    } else {
      throw new Error(`Unrecognized Trade Type: ${this.typeTrade}`);
    }

    // ── build / sign / send the commit TX ───────────────────────────
    const commitRes = await this.txsService.buildTx({ fromKeyPair, toKeyPair, payload });
    if (commitRes.error || !commitRes.data) {
      throw new Error(`Build Commit TX: ${commitRes.error}`);
    }
    const { rawtx } = commitRes.data;
    const signRes = await this.txsService.signRawTxWithWallet(rawtx);
    if (signRes.error || !signRes.data?.signedHex) {
      throw new Error(`Sign Commit TX: ${signRes.error}`);
    }
    const sendRes = await this.txsService.sendTx(signRes.data.signedHex);
    if (sendRes.error || !sendRes.data) {
      throw new Error(`Send Commit TX: ${sendRes.error}`);
    }

    // ── decode the new UTXO so we can move to STEP3 ─────────────────
    const drt = await this.client('decoderawtransaction', [rawtx]);
    if (drt.error || !drt.data?.vout) {
      throw new Error(`decoderawtransaction: ${drt.error}`);
    }
    const vout = drt.data.vout.find((o: any) =>
      o?.scriptPubKey?.addresses?.[0] === this.multySigChannelData?.address
    );
    if (!vout) {
      throw new Error('No matching vout for commit UTXO');
    }

    const utxoData: IUTXO = {
      txid:         sendRes.data,
      vout:         vout.n,
      amount:       vout.value,
      scriptPubKey: this.multySigChannelData.scriptPubKey ?? '',
      redeemScript: this.multySigChannelData.redeemScript,
      confirmations: 0
    };

    // ── emit SELLER:STEP3 with the new UTXO ─────────────────────────
    this.socket.emit(
      `${this.myInfo.socketId}::swap`,
      new SwapEvent('SELLER:STEP3', this.myInfo.socketId, utxoData)
    );

  //} catch (error: any) {
  //  this.terminateTrade(`Step 2: ${error.message}`);
  //}
}

private isSpotZeroTrade(): boolean {
  if (this.typeTrade !== ETradeType.SPOT) return false;

  // Prefer the top-level shape you showed
  if ('propIdDesired' in (this.tradeInfo as any) && 'propIdForSale' in (this.tradeInfo as any)) {
    const { propIdDesired, propIdForSale } = this.tradeInfo as any;
    return Number(propIdDesired) === 0 || Number(propIdForSale) === 0;
  }
  return false
}



  private async onStep4(
    cpId: string,
    psbtHex: string,
    commitTxId?: string   // note: optional, LTC-only branches won’t supply it
  ) {
    this.logTime('Step 4 Start');
    console.log(psbtHex)
    try {
      // 1) Basic sanity
      if (cpId !== this.cpInfo.socketId) {
        throw new Error('Step 4: p2p socket mismatch');
      }
      if (!psbtHex) {
        throw new Error('Step 4: missing PSBT');
      }

      // 2) If we have a commitTxId, pull and decode it from the node:
      const skipRbf = this.isSpotZeroTrade();
      if (commitTxId && !skipRbf) {
        // RPC: getrawtransaction with verbose=true to get vin[] & sequence
        const txRes = await this.client('getrawtransaction', [commitTxId, true]);
        if (txRes.error || !txRes.data?.vin) {
          throw new Error(`getrawtransaction failed: ${txRes.error}`);
        }
        // BIP-125: any sequence < 0xFFFFFFFE signals opt-in RBF
        const isRbf = txRes.data.vin.some((vin: any) => vin.sequence < 0xfffffffe);
        if (isRbf) {
          throw new Error('RBF-enabled commit tx detected; aborting.');
        }
      }

      // 3) Load WIF for PSBT signing
      const wifRes = await this.txsService.getWifByAddress(this.myInfo.keypair.address);
      if (wifRes.error || !wifRes.data) {
        throw new Error(`getWif failed: ${wifRes.error}`);
      }

      // 4) Sign the PSBT
      const signRes = await this.txsService.signPsbt({ wif: wifRes.data, psbtHex });
      console.log('signRes '+JSON.stringify(signRes)+' '+wifRes.data+' '+psbtHex)
      if (signRes.error || !signRes.data?.psbtHex) {
        throw new Error(`signPsbt failed: ${signRes.error}`);
      }

      // 5) Emit to seller for finalization
      this.socket.emit(
        `${this.myInfo.socketId}::swap`,
        {
          eventName: 'SELLER:STEP5',
          socketId:  this.myInfo.socketId,
          data:      signRes.data.psbtHex
        } as any
      );

    } catch (err: any) {
      this.terminateTrade(`Step 4: ${err.message}`);
    }
  }

    private async onStep6(cpId: string, finalTx: string) {
            this.logTime('Step 6 Start');
             const currentTime = Date.now();
            this.toastrService.info(`Signed! ${currentTime - this.tradeStartTime} ms`);

        //try {
            if (cpId !== this.cpInfo.socketId) /*throw new Error*/{console.log(`Error with p2p connection`)};

            const data = { txid: finalTx, seller: true, trade: this.tradeInfo };
            this.readyRes({ data });
            this.removePreviuesListeners();
        //} catch (error: any) {
        //    const errorMessage = error.message || 'Undefined Error';
        //    this.terminateTrade(`Step 6: ${errorMessage}`);
        //}
    }
}
