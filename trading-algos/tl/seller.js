const litecore = require('bitcore-lib-ltc');
const Encode = require('./tradelayer.js/src/txEncoder.js');
const { buildLitecoinTransaction, buildTokenTradeTransaction, buildFuturesTransaction, getUTXOFromCommit,signPsbtRawTx } = require('./litecoreTxBuilder');
const WalletListener = require('./tradelayer.js/src/walletInterface.js');
const util = require('util');
const BigNumber = require('bignumber.js');

class SellSwapper {
    constructor(typeTrade, tradeInfo, sellerInfo, buyerInfo, client, socket,test) {
        this.typeTrade = typeTrade;
        this.tradeInfo = tradeInfo;
        this.sellerInfo = sellerInfo;
        this.buyerInfo = buyerInfo;
        this.myInfo = sellerInfo
        this.cpInfo = buyerInfo
        this.socket = socket;
        this.client = client;
        this.test = test
        this.multySigChannelData = null
        this.tradeStartTime = Date.now();
         // Promisify methods for the given client
        this.getRawTransactionAsync = util.promisify(this.client.getRawTransaction.bind(this.client));
        this.getBlockDataAsync = util.promisify(this.client.getBlock.bind(this.client));
        this.createRawTransactionAsync = util.promisify(this.client.createRawTransaction.bind(this.client));
        this.listUnspentAsync = util.promisify(this.client.cmd.bind(this.client, 'listunspent'));
        this.decoderawtransactionAsync = util.promisify(this.client.cmd.bind(this.client, 'decoderawtransaction'));
        this.dumpprivkeyAsync = util.promisify(this.client.cmd.bind(this.client, 'dumpprivkey'));
        this.sendrawtransactionAsync = util.promisify(this.client.cmd.bind(this.client, 'sendrawtransaction'));
        this.validateAddress = util.promisify(this.client.cmd.bind(this.client, 'validateaddress'));
        this.getBlockCountAsync = util.promisify(this.client.cmd.bind(this.client, 'getblockcount'));
        this.addMultisigAddressAsync = util.promisify(this.client.cmd.bind(this.client, 'addmultisigaddress'));
        this.signrawtransactionwithwalletAsync = util.promisify(this.client.cmd.bind(this.client, 'signrawtransactionwithwallet'));
        this.signrawtransactionwithkeyAsync = util.promisify(this.client.cmd.bind(this.client, 'signrawtransactionwithkey'));

        this.handleOnEvents();
        this.onReady();
        this.initTrade();
    }

    logTime(stage) {
        const currentTime = Date.now();
        console.log(`Time taken for ${stage}: ${currentTime - this.tradeStartTime} ms`);
    }

    onReady() {
        return new Promise((resolve, reject) => {
            this.readyRes = resolve;
            // If the readyRes is not called within 60 seconds, terminate the trade
            setTimeout(() => this.terminateTrade('Undefined Error code 1'), 60000);
        });
    }

     async sendTxWithSpecRetry(rawTx) {
        const _sendTxWithRetry = async (rawTx, retriesLeft, ms) => {
            try {
                // Attempt to send the transaction
                const result = await this.sendrawtransactionAsync(rawTx);
                // If there's an error and retries are left, try again
                if (result.error && result.error.includes('bad-txns-inputs-missingorspent') && retriesLeft > 0) {
                    await new Promise(resolve => setTimeout(resolve, ms));
                    console.log('Retrying to send the transaction... Remaining retries:', retriesLeft);
                    return _sendTxWithRetry(rawTx, retriesLeft - 1, ms);
                }
                // If successful, return the result
                return result;
            } catch (error) {
                // If an error occurs during sendrawtransactionAsync, handle it here
                console.error('Error during transaction send:', error.message);
                if (retriesLeft > 0) {
                    console.log('Retrying after error... Remaining retries:', retriesLeft);
                    await new Promise(resolve => setTimeout(resolve, ms));
                    return _sendTxWithRetry(rawTx, retriesLeft - 1, ms);
                }
                return { error: 'Transaction failed after retries' }; // Return an error after all retries
            }
        }

        // Start the retry process with 15 retries and 800ms interval
        return _sendTxWithRetry(rawTx, 15, 1200);
    }


    removePreviousListeners() {
        // Correctly using template literals with backticks
        this.socket.off(`${this.cpInfo.socketId}::swap`);
    }

    terminateTrade(reason){
        // Emit the TERMINATE_TRADE event to the socket
        const eventData = {event:'TERMINATE_TRADE', socketId: this.myInfo.socketId, reason: reason};
        const tag = `${this.myInfo.socketId}::swap`;  // Correct string concatenation
        this.socket.emit(tag, eventData);
        this.removePreviousListeners(); 
    }

    handleOnEvents() {
        this.removePreviousListeners()
        const eventName = `${this.buyerInfo.socketId}::swap`;
        this.socket.on(eventName, async (eventData) => {
            const { socketId, data } = eventData;
            switch (eventData.eventName) {
                case 'BUYER:STEP2':
                    await this.onStep2(socketId, data);
                    break;
                case 'BUYER:STEP4':
                    await this.onStep4(socketId, data.psbtHex, data.commitTxId);
                    break;
                case 'BUYER:STEP6':
                    await this.onStep6(socketId, data);
                    break;
                default:
                    break;
            }
        });
    }

    async initTrade() {
        try {
            let pubKeys = [this.sellerInfo.keypair.pubkey, this.buyerInfo.keypair.pubkey];
              if (this.typeTrade === 'SPOT' && 'propIdDesired' in this.tradeInfo.props){
                let { propIdDesired, propIdForSale } = this.tradeInfo.props;
                if(propIdDesired==0||propIdForSale==0){
                     pubKeys = [this.buyerInfo.keypair.pubkey,this.sellerInfo.keypair.pubkey];
                }
              }
            console.log('pubkeys for multisig '+JSON.stringify(pubKeys))
            const multisigAddress = await this.addMultisigAddressAsync(2, pubKeys);
            this.multySigChannelData = multisigAddress

            console.log('generating multisig in sell init '+JSON.stringify(multisigAddress))
            const validateMS = await this.validateAddress(multisigAddress.address.toString());
            console.log('validated '+JSON.stringify(validateMS))
            if (validateMS.error || !validateMS.isvalid) throw new Error(`Multisig address validation failed`);

            this.multySigChannelData = { address: multisigAddress.address.toString(), redeemScript: multisigAddress.redeemScript.toString(), scriptPubKey: validateMS.scriptPubKey };
            console.log('checking this.multisig '+JSON.stringify(this.multySigChannelData))
            console.log('my info socket id '+this.myInfo.socketId+' '+this.sellerInfo.socketId)
            const swapEvent = { eventName: 'SELLER:STEP1', socketId: this.myInfo.socketId, data: this.multySigChannelData };
            console.log('show socket obj '+JSON.stringify(this.socket.emit)+' '+JSON.stringify(this.socket)+' '+this.socket)
            this.socket.emit(`${this.myInfo.socketId}::swap`, swapEvent);
        } catch (error) {
            console.error(`InitTrade Error: ${error.message}`);
        }
    }

    async onStep2(cpId) {
      this.logTime('Step 2 Start');

      // --- basic guards (same behavior, clearer logs) ---
      if (!this.multySigChannelData?.address) {
        throw new Error(`No Multisig Address`);
      }
      if (cpId !== this.buyerInfo?.socketId) {
        throw new Error(`Connection Error`);
      }

      // --- extract trade props; support SPOT (propIdDesired/amountDesired) and FUTURES (collateral/initMargin) ---
      const tprops = this.tradeInfo?.props ?? {};
      console.log('props in step 2 '+JSON.stringify(tprops))
      const isFutures = ('collateral' in tprops) || ('initMargin' in tprops);

      // SPOT defaults (original names)
      const propIdDesired = tprops.propIdDesired ?? tprops.propertyId ?? 0;
      const amountDesired = tprops.amountDesired ?? tprops.amount ?? 0;
      const transfer     = !!(tprops.transfer ?? false);

      // FUTURES defaults (desktop parity)
      const collateral = tprops.collateral ?? 0;
      const initMargin = tprops.initMargin ?? 0;

      // --- Column A/B detection (use RPC if available; otherwise default 'A') ---
      let isColumnA = true;
      try {
        if (typeof WalletListener?.getColumn === 'function') {
          const col = await WalletListener.getColumn(
            this.sellerInfo?.keypair?.address,
            this.buyerInfo?.keypair?.address
          );
          const tag = col?.data ?? col; // some impls return {data:'A'|'B'}
          isColumnA = (tag === 'A');
        } else {
          // your original hardcode
          const columnRes = 'A';
          // NOTE: your old code used columnRes.data; that would always be undefined.
          isColumnA = (columnRes === 'A');
        }
      } catch (_) {
        // fall back to A, no crash
        isColumnA = true;
      }

      // --- build TL payload (commit/transfer; spot vs futures) ---
      let payload;
      if (transfer) {
        // transfer path uses desired SPOT fields; if FUTURES provided, prefer futures collateral/initMargin
        const propertyId = isFutures ? collateral : propIdDesired;
        const amount     = isFutures ? initMargin : amountDesired;

        payload = Encode.encodeTransfer({
          propertyId,
          amount,
          isColumnA,
          destinationAddr: this.multySigChannelData.address,
        });
      } else {
        // commit path; keep your encodeCommit API
        const propertyId = isFutures ? collateral : propIdDesired;
        const amount     = isFutures ? initMargin : amountDesired;

        payload = Encode.encodeCommit({
          amount,
          propertyId,
          channelAddress: this.multySigChannelData.address,
        });
      }

      // --- UTXO selection (largest-first) ---
      console.log('calling list unspent ' + this.sellerInfo?.keypair?.address);
      const utxos = await this.listUnspentAsync(0, 999999, [this.sellerInfo.keypair.address]) ?? [];
      if (!Array.isArray(utxos) || utxos.length === 0) {
        throw new Error('No UTXOs found for seller');
      }

      const sortedUTXOs = utxos.sort((a, b) =>
        new BigNumber(b?.amount ?? 0).comparedTo(a?.amount ?? 0)
      );

      const largestUtxo = sortedUTXOs[0];
      console.log('Largest UTXO:', JSON.stringify(largestUtxo));

      const commitUTXOs = [{
        txid:         largestUtxo?.txid ?? largestUtxo?.txId,
        vout:         largestUtxo?.vout ?? largestUtxo?.n ?? 0,
        scriptPubKey: largestUtxo?.scriptPubKey,
        amount:       largestUtxo?.amount
      }];

      console.log('commitUTXOs:', JSON.stringify(commitUTXOs));

      // --- OP_RETURN payload hex ---
      const hexPayload = Buffer.from(payload ?? '', 'utf8').toString('hex');
      console.log('payload ' + payload + ' hex ' + hexPayload);

      // --- inputs/outputs (don’t assume vout 0 for the channel; we’ll decode below) ---
      const _insForRawTx = commitUTXOs.map(({ txid, vout }) => ({ txid, vout }));

      const dust = 0.000056;
      const feeSats = 0.000030; // tweak to match current fee market
      const change = new BigNumber(largestUtxo?.amount ?? 0).minus(dust).minus(feeSats).toNumber();
      if (!(change > 0)) {
        throw new Error('Insufficient UTXO for dust+fee');
      }

      const _outsForRawTx = [
        { [this.multySigChannelData.address]: dust },
        { [this.myInfo.keypair.address]: change },
        { data: hexPayload }
      ];

      console.log(
        'inputs for create raw tx ' + JSON.stringify(_insForRawTx) +
        ' outs ' + JSON.stringify(_outsForRawTx)
      );

      // --- create / decode / sign / send (same surface as your original) ---
      let crtRes = await this.createRawTransactionAsync(_insForRawTx, _outsForRawTx);

      const decoded = await this.decoderawtransactionAsync(crtRes);
      console.log('decoded ' + JSON.stringify(decoded));
      console.log('created commit tx ' + crtRes + ' type of ' + typeof(crtRes));

      const wif = await this.dumpprivkeyAsync(this.myInfo.keypair.address);
      const signResKey = await this.signrawtransactionwithkeyAsync(crtRes, [wif]);
      console.log('signed with key ' + JSON.stringify(signResKey));

      const sendRes = await this.sendrawtransactionAsync(signResKey?.hex);
      if (!sendRes) return new Error(`Failed to broadcast the transaction`);
      console.log('sent commit ' + JSON.stringify(sendRes));

      // --- locate the actual channel vout by address (don’t hardcode index 0) ---
      const voutArr = decoded?.vout ?? [];
      const channelOut = voutArr.find(o =>
        o?.scriptPubKey?.addresses?.[0] === this.multySigChannelData?.address
      ) || voutArr.find(o => o?.scriptPubKey?.asm?.includes(this.multySigChannelData?.address));

      if (!channelOut) {
        throw new Error('No matching vout for commit UTXO');
      }

      const utxoData = {
        amount:       channelOut.value ?? dust,
        vout:         channelOut.n ?? 0,
        txid:         sendRes,
        scriptPubKey: this.multySigChannelData.scriptPubKey,
        redeemScript: this.multySigChannelData.redeemScript,
      };

      const swapEvent = { eventName: 'SELLER:STEP3', socketId: this.myInfo.socketId, data: utxoData };
      // keep your surface; if you want the NPM style route, flip this to myInfo
      this.socket.emit(`${this.sellerInfo.socketId}::swap`, swapEvent);
    }

    async onStep4(cpId, psbtHex, commitTxId /* optional: only provided on token-channel flows */) {
      this.logTime('Step 4 Start');
       if (this._step4InFlight) return;
        this._step4InFlight = true;
    //try {
        console.log('cpiID '+cpId +' buyer socket '+this.buyerInfo.socketId)
        console.log('deets '+psbtHex+' '+commitTxId)
        // 1) basic sanity
        if (cpId !== this.buyerInfo?.socketId) return new Error(`Connection Error`);
        if (!psbtHex) return new Error(`Missing PSBT Hex`);

        // 2) optional anti-RBF check on the commit tx (if caller supplies it)
        if (commitTxId) {
          try {
            // Prefer an async wrapper if you have it; else fallback to raw RPC
            const res = await this.getRawTransactionAsync(commitTxId, true);
           
            console.log('res '+JSON.stringify(res))
            const vins = res.vin;
            if (!Array.isArray(vins)) throw new Error('vin missing');

            // BIP-125: any sequence < 0xFFFFFFFE signals opt-in RBF
            const isRbf = vins.some(v => {
              const seq = (v?.sequence ?? 0xffffffff) >>> 0;
              return seq < 0xfffffffe;
            });
            console.log('is RBF? '+isRbf)
            if(isRbf) throw new Error('RBF-enabled commit tx detected; aborting.');
          } catch (e) {
            return new Error(`Anti-RBF check failed: ${e?.message || e}`);
          }
        }

        // 3) pick network + sign PSBT with our WIF (your existing flow)
        let network = this.test ? 'LTCTEST' : 'LTC';
        const wif = await this.dumpprivkeyAsync(this.myInfo.keypair.address);
        const signRes = await signPsbtRawTx({ wif, network, psbtHex }, this.client);
        if (!signRes?.data?.psbtHex) return new Error(`Failed to sign the PSBT`);
        console.log('sign res '+JSON.stringify(signRes))
        if(signRes.data.isFinished){
            const sentTx = await this.sendTxWithSpecRetry(signRes.data.hex);
            const data = { txid: sentTx, seller: true, trade: this.tradeInfo };
            this.logTime('Tx Broadcast');
            this.socket.emit(`${this.sellerInfo.socketId}::complete`, data);
            return
        }
        // 4) hand signed PSBT to seller for finalization/broadcast
        const swapEvent = {
          eventName: 'SELLER:STEP5',
          socketId:  this.myInfo.socketId,
          data:      signRes.data.psbtHex
        };
        this.socket.emit(`${this.sellerInfo.socketId}::swap`, swapEvent);

      //} catch (error) {
        console.error(`Step 4 Error: ${error?.message || error}`);
      //} finally {
      //  this._step4InFlight = false;
      //}
    }

    async onStep6(cpId, finalTx) {
        this.logTime('Step 6 Start');
        try {
            if (cpId !== this.buyerInfo.socketId){console.log(`Connection Error`)};

            const data = { txid: finalTx, seller: true, trade: this.tradeInfo };
            this.socket.emit(`${this.sellerInfo.socketId}::complete`, data);
        } catch (error) {
            console.error(`Step 6 Error: ${error.message}`);
        }
    }
}

module.exports = SellSwapper;
