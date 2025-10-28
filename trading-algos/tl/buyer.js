const litecore = require('bitcore-lib-ltc');
const Encode = require('./tradelayer.js/src/txEncoder.js'); // Use encoder.js for payload generation
const BigNumber = require('bignumber.js');
const { buildLitecoinTransaction, buildTokenTradeTransaction, buildFuturesTransaction, getUTXOFromCommit, signPsbtRawTx } = require('./litecoreTxBuilder');
const WalletListener = require('./tradelayer.js/src/walletInterface.js'); // Import WalletListener to use tl_getChannelColumn
const util = require('util');
const {Psbt}= require('bitcoinjs-lib')

class BuySwapper {
    constructor(
        typeTrade, // New parameter for trade type ('BUY')
        tradeInfo, // Trade information
        buyerInfo, // Buyer information
        sellerInfo, // Seller information
        client, // Litecoin client or another client service
        socket, // Socket for communication
        test
    ) {
        this.typeTrade = typeTrade;  // 'BUY' or 'SELL'
        this.tradeInfo = tradeInfo;  // Trade information (e.g., amount, price, etc.)
        this.myInfo = buyerInfo;  // Information about the buyer
        this.cpInfo = sellerInfo;  // Information about the seller
        this.socket = socket;  // Socket connection for real-time events
        this.client = client;  // Client for making RPC calls
        this.test= test        
        this.multySigChannelData = null;  // Initialize multisig channel data

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
        this.importmultiAsync = util.promisify(client.cmd.bind(client, 'importmulti'));
        
        this.handleOnEvents();  // Set up event listeners
        this.onReady();  // Prepare for trade execution
        this.tradeStartTime = Date.now();
    }

    // Other methods for the BuySwapper class (e.g., handleOnEvents, onReady, etc.)
    onReady() {
        return new Promise((resolve, reject) => {
            this.readyRes = resolve;
            // If the readyRes is not called within 60 seconds, terminate the trade
            setTimeout(() => this.terminateTrade('Undefined Error code 1'), 60000);
        });
    }

    logTime(stage) {
        const currentTime = Date.now();
        console.log(`Time taken for ${stage}: ${currentTime - this.tradeStartTime} ms`);
    }

    removePreviousListeners() {
        // Correctly using template literals with backticks
        this.socket.off(`${this.cpInfo.socketId}::swap`);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
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

    async importMultisigNoRescan(address, redeemScriptHex) {
      try {
        // Build the request array (can hold multiple scripts)
        const request = [
          {
            // For P2WSH, Bitcoin/Litecoin Core typically uses the 'redeemscript' field
            // even though it's actually the "witnessScript."
            scriptPubKey: { address },   // The address to track
            redeemscript: redeemScriptHex,
            watchonly: true,
            timestamp: 'now',           // or block timestamp if you had it
          }
        ];

        // Pass options { rescan: false } to avoid a full chain rescan
        const options = { rescan: false };

        // Execute the importmulti call
        const result = await this.importmultiAsync(request, options);

        console.log('importmulti result:', result);
        // result is typically an array of objects with "success" and "warnings" fields
      } catch (err) {
        console.error('importMultisigNoRescan error:', err);
      }
    }


    terminateTrade(reason){
        // Emit the TERMINATE_TRADE event to the socket
        const eventData = {event:'TERMINATE_TRADE', socketId: this.myInfo.socketId, reason: reason};
        const tag = `${this.myInfo.socketId}::swap`;  // Correct string concatenation
        this.socket.emit(tag, eventData);
        this.removePreviousListeners(); 
    }

    handleOnEvents() {
        const eventName = `${this.cpInfo.socketId}::swap`;
          console.log('Received event:', JSON.stringify(eventName)); 
        this.socket.on(eventName, (eventData) => {
            console.log('event name '+eventData.eventName)
             const { socketId, data } = eventData;
            switch (eventData.eventName) {
                case 'SELLER:STEP1':
                    this.onStep1(socketId,data);
                    break;
                case 'SELLER:STEP3':
                    this.onStep3(socketId,data);
                    break;
                case 'SELLER:STEP5':
                console.log('about to call step 5 func ' +socketId+' '+JSON.stringify(data))
                    this.onStep5(socketId,data);
                    break;
                default:
                    break;
            }
        });
    }

    // Step 1: Create multisig address and verify
      async onStep1(cpId, msData) {
        console.log('cp socket Id '+JSON.stringify(cpId)+'my CP socketId '+ this.cpInfo.socketId)  
        console.log('examining trade info obj '+JSON.stringify(this.tradeInfo))

        const startStep1Time = Date.now(); // Start timing Step 1
        try {
            // Check that the provided cpId matches the expected socketId
            if (cpId !==  this.cpInfo.socketId) {
                console.log('cp socket mismatch '+Boolean(cpId !==  this.cpInfo.socketId))
                return new Error(`Error with p2p connection: Socket ID mismatch.`);
            }

            let pubKeys = [this.cpInfo.keypair.pubkey,this.myInfo.keypair.pubkey]
            if (this.typeTrade === 'SPOT' && 'propIdDesired' in this.tradeInfo.props){
                let { propIdDesired, propIdForSale } = this.tradeInfo.props;
                if(propIdDesired==0||propIdForSale==0){
                     pubKeys = [this.myInfo.keypair.pubkey,this.cpInfo.keypair.pubkey];
                }
              }
            console.log(JSON.stringify(pubKeys))
            const multisigAddress = await this.addMultisigAddressAsync(2, pubKeys);
            console.log('Created Multisig address:', multisigAddress.address, msData.address);

            if (multisigAddress.address !== msData.address){
                console.log('multisig address mismatch '+msData.address+multisigAddress.address+Boolean(multisigAddress.toString() !== msData.address))
                return new Error('Multisig address mismatch');
            }

               // Step 4: Validate redeemScript
            if (multisigAddress.redeemScript !== msData.redeemScript) {
                console.log('redeem script mismatch '+multisigAddress.redeemScript+msData.redeemScript+Boolean(multisigAddress.redeemScript !== msData.redeemScript))
                return new Error('Redeem script mismatch');
            }

            await this.importMultisigNoRescan(multisigAddress.address,multisigAddress.redeemscript)

        // Step 5: Store the multisig data
            this.multySigChannelData = msData;

            // Emit the event to the correct socketId
            console.log('about to emit step 2 '+this.myInfo.socketId)

            const step1Time = Date.now() - startStep1Time; // Time taken for Step 1
            console.log(`Time taken for Step 1: ${step1Time} ms`);
            this.socket.emit(`${this.myInfo.socketId}::swap`, { eventName: 'BUYER:STEP2', socketId: this.myInfo.socketId });

        } catch (error) {
            this.terminateTrade(`Step 1: ${error.message}`);
        }
    }

   async onStep3(cpId, commitUTXO) {
  const startStep3Time = Date.now();
  //try {
    // --- guards ---
    if (cpId !== this.cpInfo?.socketId) throw new Error(`Error with p2p connection`);
    if (!this.multySigChannelData?.address) throw new Error(`Wrong Multisig Data Provided`);

    // --- block height -> expiryBlock ---
    const gbcRes = await this.getBlockCountAsync();
    if (!Number.isFinite(gbcRes)) throw new Error('Failed to get block count from Litecoin node');
    const bbData = Number(gbcRes) + 10;

    // --- normalize trade kind (SPOT / FUTURES) ---
    const ti = this.tradeInfo ?? {};
    const props = ti.props ?? {};
    const kindRaw = String(this.typeTrade || ti.type || '').toUpperCase();
    const isSpot    = (kindRaw === 'SPOT') || ('propIdDesired' in props) || ('propIdForSale' in props);
    const isFutures = (kindRaw === 'FUTURES') || ('contract_id' in ti) || ('contractId' in ti);

    if (!isSpot && !isFutures) throw new Error('Unrecognized Trade Type');

    // --- column A/B (prefer RPC if available) ---
    let isA = 1; // default A
    try {
      if (typeof WalletListener?.getColumn === 'function') {
        const col = await WalletListener.getColumn(this.myInfo?.keypair?.address, this.cpInfo?.keypair?.address);
        const tag = col?.data ?? col;
        isA = (tag === 'A') ? 1 : 0;
      }
    } catch (_) {
      // keep default isA = 1
    }
    console.log('inside step 3'+isSpot+' '+JSON.stringify(props))
    // =========================
    // SPOT
    // =========================
    if (isSpot) {
      // safer props
      let {
        propIdDesired  = props.propertyId ?? 0,
        amountDesired  = props.amount    ?? 0,
        amountForSale  = props.amountForSale ?? 0,
        propIdForSale  = props.propIdForSale ?? 0,
        transfer       = props.transfer ?? false,
        sellerIsMaker  = props.sellerIsMaker ?? false,
      } = props;

      // LTC vs token trade
      let ltcTrade = false;
      let ltcForSale = false;
      if (propIdDesired === 0) {
        ltcTrade = true;             // buyer wants LTC -> tokens
        ltcForSale = false;
      } else if (propIdForSale === 0) {
        ltcTrade = true;             // seller offers LTC -> buyer pays tokens
        ltcForSale = true;           // <-- this was wrong in one earlier snippet
      }

      if (ltcTrade) {
        // ========== LTC <-> TOKEN (IT) ==========
        const tokenId      = ltcForSale ? propIdDesired : propIdForSale;
        const tokensSold   = ltcForSale ? amountDesired : amountForSale;
        const satsExpected = ltcForSale ? amountForSale : amountDesired;

        const payload = Encode.encodeTradeTokenForUTXO({
          propertyId:   tokenId,
          amount:       tokensSold,
          columnA:      isA === 1,     // boolean
          satsExpected,                // sats expected on-chain
          tokenOutput:  1,             // token output index preference (as in your code)
          payToAddress: 0              // same as your call surface
        });

        const network = this.test ? "LTCTEST" : "LTC";
        const buildOptions = {
          buyerKeyPair:  this.myInfo.keypair,
          sellerKeyPair: this.cpInfo.keypair,
          commitUTXOs:   [commitUTXO],
          payload,
          amount:        satsExpected,
          network
        };

        const rawHexRes = await buildLitecoinTransaction(buildOptions, this.client);
        if (!rawHexRes?.data?.psbtHex) throw new Error(`Build IT Trade: No PSBT returned`);

        const step3Time = Date.now() - startStep3Time;
        console.log(`Time taken for Step 3: ${step3Time} ms`);

        const eventData = {
          eventName: 'BUYER:STEP4',
          socketId:  this.myInfo.socketId,
          psbtHex:   rawHexRes.data.psbtHex,
          commitTxId: '' // not available here; commit comes from SELLER
        };
        this.socket.emit(`${this.myInfo.socketId}::swap`, eventData);

      } else {
        // ========== TOKEN <-> TOKEN (Channel) ==========
        // First, fund (commit or transfer) buyer-to-channel for the side they must fund:
        const commitPayload = transfer
          ? Encode.encodeTransfer({
              propertyId:      propIdDesired,
              amount:          amountDesired,
              isColumnA:       isA === 1,
              destinationAddr: this.multySigChannelData.address,
            })
          : Encode.encodeCommit({
              amount:         amountDesired,
              propertyId:     propIdDesired,
              channelAddress: this.multySigChannelData.address,
            });

        const network = this.test ? "LTCTEST" : "LTC";

        // Your NPM flow uses custom builder(s); keeping surface:
        const commitTxConfig = {
          fromKeyPair: this.myInfo.address,   // keeping your original shape
          toKeyPair:   this.cpInfo.keypair,
          payload:     commitPayload,
          network
        };

        const commitTxRes = await buildTokenTradeTransaction(commitTxConfig, this.client);
        if (!commitTxRes?.signedHex) throw new Error('Failed to sign and send the token transaction');

        // Extract UTXO from commit hex for chaining
        const utxoData = await getUTXOFromCommit(commitTxRes.signedHex, this.client);
        if (!utxoData) throw new Error('Failed to extract UTXO from commit');

        // Channel trade payload (tokens-for-tokens)
        const tradePayload = Encode.encodeTradeTokensChannel({
          propertyId1:       propIdDesired,
          propertyId2:       propIdForSale,
          amountOffered1:    amountDesired,
          amountDesired2:    amountForSale,
          columnAIsOfferer:  isA,
          expiryBlock:       bbData
        });

        const tradeOptions = {
          buyerKeyPair:  this.myInfo.address,
          sellerKeyPair: this.cpInfo.keypair,
          commitUTXOs:   [commitUTXO, utxoData],
          payload:       tradePayload,
          amount:        0,
          network
        };

        const rawHexRes = await buildTokenTradeTransaction(tradeOptions, this.client);
        if (!rawHexRes?.psbtHex) throw new Error(`Build Trade: Failed to build token trade`);

        const step3Time = Date.now() - startStep3Time;
        console.log(`Time taken for Step 3: ${step3Time} ms`);

        this.socket.emit(
          `${this.myInfo.socketId}::swap`,
          { eventName: 'BUYER:STEP4', socketId: this.myInfo.socketId, psbtHex: rawHexRes.psbtHex, commitTxId: commitTxRes.signedHex }
        );
      }

      return; // done with SPOT
    }

    // =========================
    // FUTURES
    // =========================
    if (isFutures) {
      const trade = ti; // your desktop shape puts futures fields at top-level, not in props
      const {
        contract_id,
        amount,
        price,
        initMargin = props.initMargin ?? 0,
        collateral = props.collateral ?? 0,
        transfer = props.transfer ?? false,
        sellerIsMaker = props.sellerIsMaker ?? false
      } = trade;

      // column/maker role (desktop logic)
      const columnAIsMaker = (isA === 1)
        ? (sellerIsMaker ? 1 : 0)     // seller is A
        : (!sellerIsMaker ? 1 : 0);   // seller is B

      // commit or transfer futures collateral
      const commitPayload = transfer
        ? Encode.encodeTransfer({
            propertyId:      collateral,
            amount:          initMargin,
            isColumnA:       isA === 1,
            destinationAddr: this.multySigChannelData.address,
          })
        : Encode.encodeCommit({
            propertyId:     collateral,
            amount:         initMargin,
            channelAddress: this.multySigChannelData.address,
          });

      // NPM-side: we’ll stick to your custom builders where possible
      // If you have a futures builder, call it; otherwise reuse token channel builder
      const commitTxConfig = {
        fromKeyPair: this.myInfo.address,
        toKeyPair:   this.cpInfo.keypair,
        payload:     commitPayload,
      };

      const commitTxRes = await buildFuturesTransaction
        ? await buildFuturesTransaction(commitTxConfig, this.client)
        : await buildTokenTradeTransaction(commitTxConfig, this.client);

      if (!commitTxRes?.signedHex) throw new Error('Failed to sign and send the futures commit transaction');

      const utxoData = await getUTXOFromCommit(commitTxRes.signedHex, this.client);
      if (!utxoData) throw new Error('Failed to extract UTXO from commit');

      const channelPayload = Encode.encodeTradeContractChannel({
        contractId:     contract_id ?? trade.contractId,
        amount,
        price,
        expiryBlock:    bbData,
        columnAIsSeller: isA,
        insurance:      false,
        columnAIsMaker
      });

      const network = this.test ? "LTCTEST" : "LTC";
      const futuresOptions = {
        buyerKeyPair:  this.myInfo.address,
        sellerKeyPair: this.cpInfo.keypair,
        commitUTXOs:   [commitUTXO, utxoData],
        payload:       channelPayload,
        amount:        0,
        network
      };

      const rawHexRes = await (buildFuturesTransaction
        ? buildFuturesTransaction(futuresOptions, this.client)
        : buildTokenTradeTransaction(futuresOptions, this.client));

      if (!rawHexRes?.psbtHex && !rawHexRes?.data?.psbtHex) {
        throw new Error(`Build Futures Trade: Failed to build futures trade`);
      }

      const psbtHex = rawHexRes.psbtHex ?? rawHexRes.data.psbtHex;

      const step3Time = Date.now() - startStep3Time;
      console.log(`Time taken for Step 3: ${step3Time} ms`);

      this.socket.emit(`${this.myInfo.socketId}::swap`, {
        eventName:  'BUYER:STEP4',
        socketId:   this.myInfo.socketId,
        psbtHex,
        commitTxId: commitTxRes.signedHex
      });

      return;
    }

    throw new Error(`Unrecognized Trade Type: ${this.typeTrade}`);
  //} catch (error) {
  //  const errorMessage = error?.message || 'Undefined Error';
  //  this.terminateTrade(`Step 3: ${errorMessage}`);
  //}
}


    // Step 5: Sign the PSBT using Litecore and send the final transaction
    async onStep5(cpId, psbtHex) {
        const startStep5Time = Date.now();

        /*let signed = await signpsbtAsync(psbtHex.data.psbt)
        const final = await finalizeAsync(signed.psbt)
        console.log('final '+JSON.stringify(final))
        
        const timeToCoSign = Date.now()-this.tradeStartTime
            console.log('Cosigned trade in '+timeToCoSign)

        
        console.log(sentTx)
        const psbt = Psbt.fromHex(psbtHex);
        const bigIntReplacer = (key, value) => {
          if (typeof value === 'bigint') {
            return value.toString(); // Convert BigInt to string
          }
          return value;
        };*/

        // Now, use this replacer when calling JSON.stringify
        

        // Ensure that each input has the necessary witness data
     
        try{
            // Sign the PSBT transaction using the wallet
            let wif = await this.dumpprivkeyAsync(this.myInfo.keypair.address)
            console.log('wif '+wif)
            let network = "LTC"
            if(this.test==true){
                network = "LTCTEST"
            }
            //console.log('network')
            //const signedPsbt = await signpsbtAsync(psbtHex,true)
            const signedPsbt = await signPsbtRawTx({wif:wif,network:network,psbtHex:psbtHex}, this.client);
            wif = ''
            //if (!signedPsbt || !signedPsbt.hex) return new Error('Failed to sign PSBT');
            const timeToCoSign = Date.now()-this.tradeStartTime
            console.log('Cosigned trade in '+timeToCoSign)
            console.log('complete psbt hex, finished? '+signedPsbt.data.isFinished+' '+signedPsbt.data.psbtHex)
            
            /*const psbtDecode = await decodepsbtAsync(signedPsbt.data.psbtHex)
            console.log(psbtDecode)*/
            
            const sentTx = await this.sendTxWithSpecRetry(signedPsbt.data.finalHex);
            //console.log(JSON.stringify(Psbt.fromHex(signedPsbt.data.psbtHex), bigIntReplacer))
            /*const decode = await decoderawtransactionAsync(signedPsbt.data.hex)
            console.log('decoded final tx '+ JSON.stringify(decode))

            // Send the signed transaction
            const sentTx = await sendrawtransactionAsync(signedPsbt.data.hex);
            if (!sentTx) return new Error('Failed to send the transaction');
            */
            // Emit the next step event
            const step5Time = Date.now() - startStep5Time; // Time taken for Step 3
                    //console.log(`Time taken for Step 5: ${step5Time} ms`);
            
            console.log('checking socket id'+this.myInfo.socketId)
            this.socket.emit(`${this.myInfo.socketId}::swap`, { eventName: 'BUYER:STEP6', socketId: this.myInfo.socketId, data: sentTx });
        } catch (error) {
            this.terminateTrade(`Step 5: ${error.message}`);
        }
    }
}

module.exports = BuySwapper;
