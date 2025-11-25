const litecore = require('bitcore-lib-ltc');
const util = require('util');
const BigNumber = require('bignumber.js');
const { payments, Psbt, Transaction } = require('bitcoinjs-lib');
const { ECPairFactory } = require('ecpair');
const ecc = require('tiny-secp256k1');
const ECPair = ECPairFactory(ecc);
const networks = require('./networks.js');
const minFeeLtcPerKb = 0.00002;

const NETWORKS = {
    LTCTEST: {
        messagePrefix: '\x19Litecoin Testnet Signed Message:\n',
        bech32: 'tltc',
        bip32: {
            public: 0x0436f6e1,
            private: 0x0436ef7d,
        },
        pubKeyHash: 0x6f,
        scriptHash: 0x3a,
        wif: 0xef,
    },
    LTC: {
        messagePrefix: '\x19Litecoin Signed Message:\n',
        bech32: 'ltc',
        bip32: {
            public: 0x019da462,
            private: 0x019d9cfe,
        },
        pubKeyHash: 0x30,
        scriptHash: 0x32,
        wif: 0xb0,
    },
};

const getNetworkConfig = (networkCode) => {
    const network = NETWORKS[networkCode];
    if (!network) {
        throw new Error(`Unsupported network code: ${networkCode}`);
    }
    return network;
};


const initializePromisifiedMethods = (client) => ({
    walletCreateFundedPsbtAsync: util.promisify(client.cmd.bind(client, 'walletcreatefundedpsbt')),
    createPsbtAsync: util.promisify(client.cmd.bind(client, 'createpsbt')),
    decodeRawTransactionAsync: util.promisify(client.cmd.bind(client, 'decoderawtransaction')),
    createRawTransactionAsync: util.promisify(client.cmd.bind(client, 'createrawtransaction')),
    listUnspentAsync: util.promisify(client.cmd.bind(client, 'listunspent')),
    decoderawtransactionAsync: util.promisify(client.cmd.bind(client, 'decoderawtransaction')),
    dumpprivkeyAsync: util.promisify(client.cmd.bind(client, 'dumpprivkey')),
    sendrawtransactionAsync: util.promisify(client.cmd.bind(client, 'sendrawtransaction')),
    validateAddress: util.promisify(client.cmd.bind(client, 'validateaddress')),
    getBlockCountAsync: util.promisify(client.cmd.bind(client, 'getblockcount')),
    loadWalletAsync: util.promisify(client.cmd.bind(client, 'loadwallet')),
    addMultisigAddressAsync: util.promisify(client.cmd.bind(client, 'addmultisigaddress')),
    signrawtransactionwithwalletAsync: util.promisify(client.cmd.bind(client, 'signrawtransactionwithwallet')),
    signpsbtAsync: util.promisify(client.cmd.bind(client, 'walletprocesspsbt')),
    decodepsbtAsync: util.promisify(client.cmd.bind(client, 'decodepsbt')),
    finalizeAsync: util.promisify(client.cmd.bind(client, 'finalizepsbt')),
});

function formatAmount(amt) {
  // Work in satoshis and back to LTC string
  return (Math.floor(new BigNumber(amt).times(1e8).toNumber()) / 1e8).toFixed(8);
}

// Functions refactored to accept `client` and use its methods
const buildLitecoinTransaction = async (txConfig, client) => {
    try {
        const {
            buyerKeyPair,
            sellerKeyPair,
            amount,
            payload,
            commitUTXOs,
            network = 'LTCTEST',
        } = txConfig;

        const { listUnspentAsync, createRawTransactionAsync } = initializePromisifiedMethods(client);

        const buyerAddress = buyerKeyPair.address;
        const sellerAddress = sellerKeyPair.address;

        // Fetch unspent UTXOs for the buyer
        const luRes = await listUnspentAsync(); 
        const _utxos = luRes
            .map((i) => ({ ...i, pubkey: buyerKeyPair.pubkey }))
            .sort((a, b) => b.amount - a.amount);   


        const utxos = [...commitUTXOs, ..._utxos];
        const minAmount = 0.000056;
        const buyerLtcAmount = minAmount;
        const sellerLtcAmount = Math.max(amount, minAmount);
        const minAmountForAllOuts = buyerLtcAmount + sellerLtcAmount;
        console.log('utxos before get getEnoughInputs2 '+JSON.stringify(utxos))
        const inputsRes = getEnoughInputs2(utxos, minAmountForAllOuts);
        const { finalInputs, fee, amountSum } = inputsRes;
        console.log('final inputs' +JSON.stringify(finalInputs))
        const _inputsSum = finalInputs
        .map(({ amount }) => new BigNumber(amount))
        .reduce((a, b) => a.plus(b), new BigNumber(0));        
        const inputsSum = _inputsSum;


        const changeBuyerLtcAmount = Math.max(inputsSum - sellerLtcAmount - fee, buyerLtcAmount);

        const hexPayload = Buffer.from(payload, 'utf8').toString('hex');
        const _insForRawTx = finalInputs.map(({ txid, vout }) => ({ txid, vout }));
        const _outsForRawTx = [
            { [buyerAddress]: formatAmount(changeBuyerLtcAmount) },
            { [sellerAddress]: formatAmount(sellerLtcAmount) },
            { data: hexPayload },
        ];

        console.log('outs for create raw tx utxo trade '+JSON.stringify(_outsForRawTx))
        const crtRes = await createRawTransactionAsync(_insForRawTx, _outsForRawTx);
        const finalTx = crtRes;

        const psbtHexConfig = {
            rawtx: finalTx,
            inputs: finalInputs,
        };

        console.log('psbt config '+JSON.stringify(psbtHexConfig))

        const psbtHexRes = await buildPsbtViaRpc(psbtHexConfig, client, network);
        if (psbtHexRes.error) throw new Error(`buildPsbt: ${psbtHexRes.error}`);

        return { data: { rawtx: finalTx, inputs: finalInputs, psbtHex: psbtHexRes.data } };
    } catch (error) {
        console.error('Error building Litecoin transaction:', error);
        return { error: error.message || 'Error building transaction' };
    }
};

/**
 * Build a PSBT using the Litecoin Core node via walletcreatefundedpsbt,
 * then inject witnessScripts/amounts for custom P2WSH, and finally export PSBT as hex.
 *
 * @param {Object} buildPsbtOptions - { rawtx, inputs[] }
 *     rawtx: hex-encoded "template" transaction (with desired outputs).
 *     inputs: array of objects, each at least:
 *       { txid, vout, amount, scriptPubKey, witnessScript? }
 *         - 'amount' is in LTC (e.g. 0.0000546)
 *         - 'witnessScript' is optional if you have a native P2WSH 2-of-2, etc.
 * @param {Object} client - The RPC client connected to your LTC node
 * @param {String} networkCode - e.g. 'LTCTEST' or 'LTC'
 * @returns {Promise<{ data?: string, error?: string }>} PSBT in hex form
 */
async function buildPsbtViaRpc(buildPsbtOptions, client, networkCode) {
  const {
    createPsbtAsync,
    decodeRawTransactionAsync,
    decodepsbtAsync
  } = initializePromisifiedMethods(client);

  //try {
    const { rawtx, inputs } = buildPsbtOptions;
    if (!rawtx) throw new Error('Missing rawtx');

    // 1) Decode the raw TX to gather its outputs (e.g. [ { address: X, amount: Y }, { data: "hex" }, ... ])
    const decoded = await decodeRawTransactionAsync(rawtx);
    if (!decoded || !decoded.vout) {
      throw new Error('Failed to decode raw transaction');
    }

    // We convert each output into the format needed by walletcreatefundedpsbt:
    // { [address]: amount } or { data: <hex payload> } for OP_RETURN
    const outputsForRpc = [];
    for (const out of decoded.vout) {
      const value = out.value; // LTC
      const spk = out.scriptPubKey;

      if (spk.type === 'nulldata') {
        // OP_RETURN
        // Usually 'asm' is "OP_RETURN <payload-hex>"
        const parts = spk.asm ? spk.asm.split(' ') : [];
        const opReturnHex = parts[1] || '';
        outputsForRpc.push({ data: opReturnHex });
      } else {
        // Standard address output
        const address = spk.addresses && spk.addresses[0];
        if (!address) {
          throw new Error(`Output script is not recognized as an address: ${spk.asm}`);
        }
        outputsForRpc.push({ [address]: value });
      }
    }

    // 2) Build the 'inputs' param for walletcreatefundedpsbt
    // Typically: { txid, vout, ...(optionally "sequence", "amount") }
    // If you pass "amount", it's in LTC. This can help the node if it doesn't know the UTXO or if watch-only.
    const inputsForRpc = inputs.map((inp) => ({
      txid: inp.txid,
      vout: inp.vout,
      // optional: sequence, e.g. 0xffffffff
      amount: inp.amount, // walletcreatefundedpsbt expects LTC for watch-only or unknown UTXOs
    }));

    // 3) Call walletcreatefundedpsbt to form a partial PSBT
    // - We pass 0 for locktime, an empty or custom options object, and bip32derivs = false if you prefer.
    const options = {
      // example: feeRate: 0.00002,
      // example: includeWatching: true,
      "include_unsafe": true
    };
    const bip32derivs = false; // whether to store BIP32 derivation info in the PSBT

    console.log('outputs and inputs for psbt '+JSON.stringify(inputsForRpc)+' '+JSON.stringify(outputsForRpc))
    const result = await createPsbtAsync(inputsForRpc, outputsForRpc);
    console.log('create psbt result '+JSON.stringify(result))

    const decode = await decodepsbtAsync(result)
    console.log('decode '+JSON.stringify(decode))
    // 4) Convert the base64 PSBT => bitcoinjs-lib PSBT object
    // Provide the correct LTC network parameters
    const network = getNetworkConfig(networkCode); // your function that returns { bech32, bip32, ... }
    let psbt = Psbt.fromBase64(result, { network });

    // 5) Inject the correct "value" (amount in satoshis) and optional "witnessScript" for each input
    //    Because walletcreatefundedpsbt may not know about custom witnessScripts.
    //    Also ensure each input has the correct 'value' in satoshis for PSBT correctness.
    inputs.forEach((inp, i) => {
    const valueSats = new BigNumber(inp.amount).times(1e8).integerValue().toNumber();      // 'witnessUtxo' => { script: Buffer, value: bigInt } for segwit
      const script = Buffer.from(inp.scriptPubKey, 'hex');

      // Update the input to ensure the correct witnessUtxo
      // (the node might have done this already if it's in your wallet, but let's be certain)
      psbt.updateInput(i, {
        witnessUtxo: {
          script,
          value: valueSats,
        },
      });

      // If this is a P2WSH with a known 2-of-2 script, attach it:
      if (inp.redeemScript) {
        psbt.updateInput(i, {
          witnessScript: Buffer.from(inp.redeemScript, 'hex'),
        });
      }
    });

    // 6) Export the final PSBT as hex, so you can share with other signers using bitcoinjs-lib
    const psbtHex = psbt.toHex();
    return { data: psbtHex };

  //} catch (err) {
  //  console.error('buildPsbtViaRpc error:', err.message);
  //  return { error: err.message };
  //}
}


/*
const buildPsbt = (buildPsbtOptions, networkCode) => {
    try {
        const { rawtx, inputs } = buildPsbtOptions;
        const tx = Transaction.fromHex(rawtx);
             const network = getNetworkConfig(networkCode);
             console.log('network code '+networkCode+JSON.stringify(network))
        const psbt = new Psbt({ network: network });

        inputs.forEach((input) => {
            const hash = input.txid;
            const index = input.vout;
            const value = BigInt(input.amount * 100000000);
            const script = Uint8Array.from(Buffer.from(input.scriptPubKey, 'hex'));
            const witnessUtxo = { script, value };
            const inputObj = { hash, index, witnessUtxo };

            if (input.redeemScript) {
                inputObj.witnessScript = Uint8Array.from(Buffer.from(input.redeemScript, 'hex'));
            }

            psbt.addInput(inputObj);
        });

        tx.outs.forEach((output) => {
            psbt.addOutput(output);
        });

        const psbtHex = psbt.toHex();
        return { data: psbtHex };
    } catch (error) {
        console.error('Error building PSBT:', error.message);
        return { error: error.message };
    }
};*/

const getEnoughInputs2 = (_inputs, amount) => {
    const finalInputs = [];
    let amountSum= 0
    _inputs.forEach((u) => {
        const _amountSum = finalInputs
            .map((r) => new BigNumber(r.amount))
            .reduce((a, b) => a.plus(b), new BigNumber(0));
        amountSum += _amountSum.toNumber();
        const _fee = new BigNumber(0.2 * minFeeLtcPerKb).times(finalInputs.length + 1).toNumber();
        if (amountSum < new BigNumber(amount).plus(_fee).toNumber()) finalInputs.push(u);
    });
    const fee = new BigNumber(0.2 * minFeeLtcPerKb).times(finalInputs.length).toNumber();
    return { finalInputs, fee, amountSum };
};


const getEnoughInputs = (_inputs, amount) => {
    const finalInputs = [];
    _inputs.forEach(u => {
        const _amountSum = finalInputs.map(r => new BigNumber(r.amount)).reduce((a, b) => a.plus(b), new BigNumber(0)); // Sum inputs using BigNumber
        const amountSum = _amountSum.toNumber(); // Convert back to regular number
        if (amountSum < new BigNumber(amount).toNumber()) finalInputs.push(u);  // Adds inputs until the sum reaches 'amount'
    });
    const fee = new BigNumber(0.2 * minFeeLtcPerKb).times(finalInputs.length).toNumber();  // Fee based on selected inputs
    return { finalInputs, fee };
};

/*
const signPsbtRawTx = (signOptions, client) => {
    try {
        const {wif, network, psbtHex } = signOptions;
        const {signpsbtAsync} = initializePromisifiedMethods(client)
        const psbt = Psbt.fromHex(psbtHex); 
        //const psbt64 = Psbt.toBase64(psbt)
        //const signResult = signpsbtAsync(psbt64)
        console.log('sign psbt params '+JSON.stringify(signOptions))
             const networkObj = getNetworkConfig(network);
        const keypair = ECPair.fromWIF(wif, networkObj); // Derive keypair from WIF (Wallet Import Format)
        console.log('network '+JSON.stringify(networkObj))// Create a Psbt instance from the provided hex
        console.log('Signing inputs with keypair:', keypair.publicKey.toString('hex'));
        psbt.data.inputs.forEach((input, i) => {
            console.log(`Input ${i}:`, input);
        });
        console.log('components inside sign Psbt Raw '+JSON.stringify(keypair)+' '+psbt+' '+psbtHex)
        // Sign all inputs using the provided keyPair
        psbt.signAllInputs(keypair);

        const newPsbtHex = psbt.toHex(); // Get the hex of the PSBT after signing

        console.log('output '+newPsbtHex)
        try {
            psbt.finalizeAllInputs(); // Finalize the inputs of the PSBT (lock them for signing)
            //psbt.validate();
            
            const finalHex = psbt.extractTransaction().toHex(); // Extract the final transaction in hex
            console.log('final hex '+finalHex)
            return { data: { psbtHex: newPsbtHex, isFinished: true, hex: finalHex } };
        } catch (err) {
            console.log('cant finalize a partially signed psbt')
            return { data: { psbtHex: newPsbtHex, isFinished: false } }; // Return hex if finalizing fails
        }
    } catch (error) {

        return { error: error.message }; // Catch any errors and return the error message
    }
};*/

    const signPsbtRawTx = async (signOptions, client) => {
        try {
            const { wif, network, psbtHex } = signOptions;
            const { signpsbtAsync } = initializePromisifiedMethods(client);

            // Convert PSBT to Base64 for RPC
            const psbt = Psbt.fromHex(psbtHex); // Load the PSBT from hex
            const psbt64 = psbt.toBase64(); // Convert PSBT to Base64 (required for RPC)

            console.log('PSBT in Base64:', psbt64);

            // Use RPC to sign the PSBT
            const signResult = await signpsbtAsync(psbt64);

            console.log('RPC Sign Result:', signResult);

            // Check if the RPC returned a valid result
            if (!signResult || !signResult.psbt) {
                throw new Error('RPC signing failed or returned invalid result');
            }

            // Convert the returned PSBT back to a Psbt object
            const signedPsbt = Psbt.fromBase64(signResult.psbt);
            const signedHex = signedPsbt.toHex()
            // Check if the PSBT is finalized
            console.log('signed hex '+JSON.stringify(signedHex))
            if (signResult.complete) {
                const finalHex = signedPsbt.extractTransaction().toHex(); // Extract the final transaction
                console.log('Finalized Transaction Hex:', finalHex);
                return { data: { psbtHex: signResult.psbt, isFinished: true, hex: finalHex } };
            } else {
                console.log('PSBT partially signed, returning for further processing.');
                return { data: { psbtHex: signedHex, isFinished: false } };
            }
        } catch (error) {
            console.error('Error during RPC PSBT signing:', error.message);
            return { error: error.message };
        }
    };


// Function to build and sign Token Trade transaction
const buildTokenTradeTransaction = async (trade, buyerKeyPair, sellerKeyPair, commitUTXOs, payload, client) => {
    try {
        const { signrawtransactionwithwalletAsync } = initializePromisifiedMethods(client);

        const transaction = new litecore.Transaction();

        // Add inputs (UTXOs)
        commitUTXOs.forEach(utxo => {
            transaction.from({
                txId: utxo.txid,
                outputIndex: utxo.vout,
                script: utxo.scriptPubKey,
                satoshis: new BigNumber(utxo.amount).times(1e8).integerValue().toNumber()
            });
        });

        // Add outputs (token trade via OP_RETURN)
        transaction.addData(payload);

        // Serialize transaction to raw hex
        const rawTxHex = transaction.serialize();

        // Sign the transaction using the Litecoin wallet
        const signResult = await signrawtransactionwithwalletAsync(rawTxHex);
        if (!signResult || !signResult.hex) {
            throw new Error('Signing transaction failed');
        }

        return signResult.hex;
    } catch (error) {
        throw new Error(`Token Trade Transaction Build Error: ${error.message}`);
    }
};

// Function to build and sign Futures Transaction
const buildFuturesTransaction = async (trade, buyerKeyPair, sellerKeyPair, commitUTXOs, payload, client) => {
    try {
        const { signrawtransactionwithwalletAsync } = initializePromisifiedMethods(client);

        const transaction = new litecore.Transaction();

        // Add inputs (UTXOs)
        commitUTXOs.forEach(utxo => {
            transaction.from({
                txId: utxo.txid,
                outputIndex: utxo.vout,
                script: utxo.scriptPubKey,
                satoshis: new BigNumber(utxo.amount).times(1e8).integerValue().toNumber()
            });
        });

        // Add outputs (futures trade via OP_RETURN)
        transaction.addData(payload);

        // Serialize transaction to raw hex
        const rawTxHex = transaction.serialize();

        // Sign the transaction using the Litecoin wallet
        const signResult = await signrawtransactionwithwalletAsync(rawTxHex);
        if (!signResult || !signResult.hex) {
            throw new Error('Signing transaction failed');
        }

        return signResult.hex;
    } catch (error) {
        throw new Error(`Futures Transaction Build Error: ${error.message}`);
    }
};

const getUTXOFromCommit = async (rawtx, multySigChannelData, client, network) => {
    try {
        // Initialize promisified methods for the client
        const { decoderawtransactionAsync } = initializePromisifiedMethods(client);

        // Decode the raw transaction
        const decodedTx = await decoderawtransactionAsync(rawtx);
        if (!decodedTx || !decodedTx.vout) {
            throw new Error('Failed to decode raw transaction');
        }

        // Find the UTXO matching the multisig channel address
        const vout = decodedTx.vout.find(output => 
            output.scriptPubKey?.addresses?.includes(multySigChannelData?.address)
        );
        if (!vout) {
            throw new Error('UTXO for multisig address not found');
        }

        // Return the UTXO details
        return {
            amount: vout.value,
            vout: vout.n,
            txid: decodedTx.txid,
            scriptPubKey: multySigChannelData.scriptPubKey,
            redeemScript: multySigChannelData.redeemScript,
            network, // Pass the network for consistency
        };
    } catch (error) {
        throw new Error(`getUTXOFromCommit Error: ${error.message}`);
    }
};

module.exports = {
    buildLitecoinTransaction,
    buildTokenTradeTransaction,
    buildFuturesTransaction,
    getUTXOFromCommit,
    signPsbtRawTx
};
