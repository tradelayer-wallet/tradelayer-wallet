// Import the necessary library for interacting with Litecoin
const Litecoin = require('litecoin'); // Replace with actual library import
const async = require('async')
const util = require('util');
const litecore = require('bitcore-lib-ltc');
const Encode = require('./txEncoder.js')
const COIN = 100000000
const STANDARD_FEE = 10000; // Standard fee in LTC
const client = new Litecoin.Client({
    host: '127.0.0.1',
    port: 18332,
    user: 'user',
    pass: 'pass',
    timeout: 10000
});

// Promisify the necessary client functions
const getRawTransactionAsync = util.promisify(client.getRawTransaction.bind(client));
const getBlockDataAsync = util.promisify(client.getBlock.bind(client))
const createRawTransactionAsync = util.promisify(client.createRawTransaction.bind(client));
const listUnspentAsync = util.promisify(client.cmd.bind(client, 'listunspent'));
const decoderawtransactionAsync = util.promisify(client.cmd.bind(client, 'decoderawtransaction'));
const signrawtransactionwithwalletAsync = util.promisify(client.cmd.bind(client, 'signrawtransactionwithwallet'));
const dumpprivkeyAsync = util.promisify(client.cmd.bind(client, 'dumpprivkey'))
const sendrawtransactionAsync = util.promisify(client.cmd.bind(client,'sendrawtransaction'))
const validateAddress = util.promisify(client.cmd.bind(client,'validateaddress'))
const getBlockCountAsync = util.promisify(client.cmd.bind(client, 'getblockcount'))
const DUST_THRESHOLD= 54600

const TxUtils = {
    async getRawTransaction(txid) {
        let transaction;
        try {
            transaction = await getRawTransactionAsync(txid, true);
            //console.log(`Transaction:`, transaction);
        } catch (error) {
            console.error(`Error fetching transaction for txid ${txid}:`, error);
        }
        return transaction;
    },

    async validateAddressWrapper(address){
        return await validateAddress(address)
    },

    async addOPReturn(txBlob,payload){
        return new litecore.Transaction(txBlob).addData(payload)
    },

    async getBlockHeight(blockhash){
        let block;
        try {
            block = await getBlockDataAsync(blockhash, 1);
            //console.log(`Block data:`, block);
        } catch (error) {
            console.error(`Error fetching transaction for txid ${blockhash}:`, error);
        }
        return block.height;
    },

    async getBlockCount(){
        let height;
        try{
            height = await getBlockCountAsync()
        } catch (error) {
            console.error(`Error fetching transaction for txid ${blockhash}:`, error);
        }
        return height;
    },

    /*async fetchTransactionData(txId) {
        console.log('fetching tx data '+txId)
        return new Promise((resolve, reject) => {
            TxUtils.client.getRawTransaction(txId, true, (error, transaction) => {
                if (error) {
                    console.log('blah '+error);
                    reject(error);
                } else {
                    resolve(transaction);
                }
            });
        });
    },*/


    async getSender(txId) {
        let tx
        try{
            tx = await TxUtils.getRawTransaction(txId)
        }catch(err){
            console.log('err getting tx for sender'+err)
        }

        if (!tx || !tx.vin || tx.vin.length === 0) {
            return new Error(`Invalid transaction data for ${txId}`);
        }

        const vin = tx.vin[0]; // Assuming we're only interested in the first input
        if (!vin.txid) {
            return new Error(`No previous transaction reference in input for ${vin.txid}`);
        }
                //console.log('get sender tx id '+vin.txid)

        const parentTx = await TxUtils.getRawTransaction(vin.txid)
        if (!parentTx || !parentTx.vout || parentTx.vout.length <= vin.vout) {
            return new Error(`Invalid parent transaction data for ${vin.txid}`);
        }

        const output = parentTx.vout[vin.vout];
        if (!output || !output.scriptPubKey || !output.scriptPubKey.addresses) {
            return new Error(`No output found for vin ${vin.vout} in transaction ${vin.txid}`);
        }

        const senderAddress = output.scriptPubKey.addresses[0]; // Assuming single address
        const amount = output.value; // Amount in LTC
        //console.log(senderAddress,amount)
        return { senderAddress, amount };
    },

    async getReference(txId) {
        let tx
        try {
            tx = await getRawTransactionAsync(txId, true);
            if (!tx || !tx.vout) {
                return new Error(`Invalid transaction data for ${txId}`);
            }

            let referenceOutput = null;

            // Iterate over outputs to find the last non-OP_RETURN output
            for (let i = tx.vout.length - 1; i >= 0; i--) {
                const output = tx.vout[i];
                if (output.scriptPubKey.type !== 'nulldata') { // 'nulldata' type is typically used for OP_RETURN
                    referenceOutput = output;
                    break;
                }
            }

            if (referenceOutput) {
                const address = referenceOutput.scriptPubKey.addresses[0]; // Assuming single address
                const satoshis = Math.round(referenceOutput.value * COIN); // Convert LTC to satoshis
                //console.log(satoshis)
                return { address, satoshis };
            } else {
                return new Error("Reference output not found");
            }
        } catch (error) {
            console.error(`Error in getReference for transaction ${txId}:`, error);
            return error;
        }
    },
 
    async getReferenceAddresses(txId) {
        let tx;
        try {
            tx = await getRawTransactionAsync(txId, true); // Fetch the raw transaction data
            if (!tx || !tx.vout) {
                return new Error(`Invalid transaction data for ${txId}`);
            }

            const referenceAddresses = [];

            // Iterate over outputs to find reference outputs
            for (let i = 0; i < tx.vout.length; i++) {
                const output = tx.vout[i];

                // Check for OP_RETURN
                if (output.scriptPubKey.type === 'nulldata') {
                    // If OP_RETURN is found, previous output is a reference (if it exists)
                    if (i > 0) {
                        const prevOutput = tx.vout[i - 1];
                        referenceAddresses.push(prevOutput.scriptPubKey.addresses[0]);
                    }
                } else if (output.value < 2 * DUST_THRESHOLD / COIN) {
                    // If the output amount is less than twice the dust threshold, consider it as a reference
                    referenceAddresses.push(output.scriptPubKey.addresses[0]);
                }
            }

            return referenceAddresses.length > 0 ? referenceAddresses : new Error("No reference outputs found");
        } catch (error) {
            console.error(`Error in getReferenceAddresses for transaction ${txId}:`, error);
            return error;
        }
    },

    async listUnspent(minconf, maxconf, addresses) {
        try {
            // Use the promisified version of listUnspent
            return await listUnspentAsync(minconf, maxconf, addresses);
        } catch (error) {
            console.error(`Error listing UTXOs:`, error);
            return error;
        }
    },

    async decoderawtransaction(hexString) {
        try {
            // Use the promisified version of decoderawtransaction
            console.log('decoding')
            return await decoderawtransactionAsync(hexString);
        } catch (error) {
            console.error(`Error decoding raw transaction:`, error);
            return error;
        }
    },

    async signrawtransactionwithwallet(rawTx) {
        try {
            // Use the promisified version of signrawtransactionwithwallet
            return await signrawtransactionwithwalletAsync(rawTx);
        } catch (error) {
            console.error(`Error signing raw transaction with wallet:`, error);
            return error;
        }
    },

        async getPayload(rawTx) {
            if (!rawTx || !rawTx.vout) {
                console.error("Invalid transaction data or missing 'vout' property.");
                return null; // Return null to indicate no payload was found and maintain consistent return type
            }

            for (const output of rawTx.vout) {
                if (output.scriptPubKey.type === 'nulldata') {
                    const payloadData = output.scriptPubKey.asm;

                    // If payload data needs to be converted from hex to string, add that logic here.
                    // Example: Convert hex to string if needed
                    // const payloadString = hexToString(payloadData); 

                    // Logging the payload for debugging - consider the sensitivity of this data
                    console.log("Extracted payload: ", payloadData);

                    return payloadData; // Return the payload data as is or after conversion
                }
            }

            console.log("No payload found in transaction.");
            return null; // Return null if no payload is found
        },

        // Example helper function to convert hex to string (if needed)
        hexToString(hexString) {
            var str = '';
            for (var i = 0; i < hexString.length; i += 2) {
                var v = parseInt(hexString.substr(i, 2), 16);
                if (v) str += String.fromCharCode(v);
            }
            return str;
        },


    async getAdditionalInputs(txId) {
        try {
            const tx = await getRawTransactionAsync(txId, true);
            if (!tx || !tx.vin || tx.vin.length <= 1) {
                return []; // No additional inputs beyond the first
            }

            let additionalInputs = [];
            for (let i = 1; i < tx.vin.length; i++) { // Start from second input
                const input = tx.vin[i];

                if (!input.txid) {
                    return new Error(`No previous transaction reference in input for ${txId}`);
                }

                const parentTx = await getRawTransactionAsync(input.txid, true);
                if (!parentTx || !parentTx.vout || parentTx.vout.length <= input.vout) {
                    return new Error(`Invalid parent transaction data for ${input.txid}`);
                }

                const output = parentTx.vout[input.vout];
                if (!output || !output.scriptPubKey || !output.scriptPubKey.addresses) {
                    return new Error(`No output found for vin ${input.vout} in transaction ${input.txid}`);
                }

                const address = output.scriptPubKey.addresses[0]; // Assuming single address
                const amount = output.value; // Amount in LTC

                additionalInputs.push({ address, amount });
            }

            return additionalInputs;
        } catch (error) {
            console.error(`Error in getAdditionalInputs for transaction ${txId}:`, error);
            return error;
        }
    },

    async setSender(address, requiredAmount) {
        // First, get UTXOs for the specific address
        let utxos = await listUnspentAsync('listunspent', 0, 9999999, [address]);

        // Sort UTXOs by amount, descending
        utxos.sort((a, b) => b.amount - a.amount);

        let selectedUtxos = [];
        let totalAmount = 0;

        // Try to meet the required amount with UTXOs from the specified address
        for (let utxo of utxos) {
            selectedUtxos.push(utxo);
            totalAmount += utxo.amount;
            if (totalAmount >= requiredAmount) {
                return selectedUtxos;
            }
        }

        // If not enough, get all UTXOs in the wallet
        let allUtxos = await client.cmd('listunspent', 0, 9999999);
        // Exclude UTXOs already selected
        allUtxos = allUtxos.filter(utxo => !selectedUtxos.includes(utxo));

        // Sort the remaining UTXOs by amount, descending
        allUtxos.sort((a, b) => b.amount - a.amount);

        // Add additional UTXOs from the wallet
        for (let utxo of allUtxos) {
            if (utxo.address !== address) { // Ensure UTXOs from the specified address are first
                selectedUtxos.push(utxo);
                totalAmount += utxo.amount;
                if (totalAmount >= requiredAmount) {
                    break;
                }
            }
        }

        // Check if the total amount is still insufficient
        if (totalAmount < requiredAmount) {
            return new Error('Insufficient funds: Total UTXOs amount is less than the required amount');
        }

        return selectedUtxos;
    },

    async createRawTransaction(inputs, outputs, locktime = 0, replaceable = false) {
        const transaction = new litecore.Transaction();

        for (const input of inputs) {
            // Fetch the raw transaction to which this input refers
            const tx = await getRawTransactionAsync(input.txid, true);
            const utxo = tx.vout[input.vout];
            const scriptPubKey = utxo.scriptPubKey.hex;
            const value = Math.round(utxo.value*COIN)
            console.log(value)
            // Add UTXO to the transaction
            transaction.from({
                txId: input.txid,
                outputIndex: input.vout,
                script: scriptPubKey,
                satoshis: value // Convert LTC to satoshis
            });
        }

            // Add outputs
            outputs.forEach(output => {
                if (output.address) {
                    transaction.to(output.address, output.amount * COIN); // Convert LTC to satoshis
                    console.log(output.amount*COIN)
                }
                // Handle data (OP_RETURN) outputs
                else if (output.data) {
                    const script = litecore.Script.buildDataOut(output.data, 'hex');
                    transaction.addOutput(new litecore.Transaction.Output({ script: script, satoshis: 0 }));
                }
            });

            // Set locktime if specified
            if (locktime > 0) {
                transaction.lockUntilDate(locktime);
            }

            return transaction;
    },

    addPayload(payload, rawTx) {
        const transaction = new litecore.Transaction(rawTx);
        const script = litecore.Script.buildDataOut('tl' + payload, 'hex');
        transaction.addOutput(new litecore.Transaction.Output({ script: script, satoshis: 0 }));
        return transaction.toString();
    },

    async setChange(senderAddress, amount, rawTx) {
            const transaction = new litecore.Transaction(rawTx);

            // Log the transaction's inputs and outputs for debugging
            console.log("Transaction inputs:", transaction.inputs);
            console.log("Transaction outputs:", transaction.outputs);

            // Calculate change amount
            const inputAmount = transaction.inputs.reduce((sum, input) => {
                console.log("Current input:", input); // Log each input
                return sum + (input.output ? input.output.satoshis : 0);
            }, 0);

            const outputAmount = transaction.outputs.reduce((sum, output) => {
                console.log("Current output:", output); // Log each output
                return sum + output.satoshis;
            }, 0);

            const changeAmount = inputAmount - outputAmount - (STANDARD_FEE * 1e8); // Convert LTC to satoshis

            // Log the calculated change amount
            console.log("Calculated change amount (in satoshis):", changeAmount);

            // Add change output if above dust threshold
            if (changeAmount > DUST_THRESHOLD * 1e8) {
                transaction.change(senderAddress);
            }

            return transaction.serialize();
    },

    signTransaction(rawTx, privateKey) {
        const transaction = new litecore.Transaction(rawTx);
        const privateKeyObj = new litecore.PrivateKey(privateKey);
        transaction.sign(privateKeyObj);
        return transaction.toString();
    },

    async beginRawTransaction(txid, vout) {
        try {
            // Specify the input using txid and vout
            const inputs = [{
                txid: txid,
                vout: vout
            }];

            // Define a minimal set of outputs, can be an empty object for now
            const outputs = {};

            // Create the raw transaction
            const rawTx = await TxUtils.createRawTransaction(inputs, [outputs]);

            return rawTx;
        } catch (error) {
            console.error(`Error in createRawTransaction:`, error);
            return error;
        }
    },


    async addInputs(utxos, rawTx) {
        // Decode the raw transaction to modify it
        let decodedTx = await decoderawtransactionAsync('decoderawtransaction', rawTx);

        // Add each UTXO as an input
        utxos.forEach(utxo => {
            decodedTx.vin.push({
                txid: utxo.txid,
                vout: utxo.vout
            });
        });

        // Re-encode the transaction
        return await client.cmd('createrawtransaction', decodedTx.vin, decodedTx.vout);
    },

    async constructInitialTradeTokenTx(params, senderChannel) {
        // Retrieve the UTXO for the senderChannel address
        const utxos = await listUnspentAsync('listunspent', 0, 9999999, [senderChannel]);
        if (utxos.length === 0) {
            return new Error('No UTXOs found for the sender channel address');
        }
        // Select the appropriate UTXO (e.g., based on criteria like highest amount or specific logic)
        const selectedUtxo = utxos[0]; // Simple selection logic, adjust as needed

        // Update params with the chosen UTXO details
        params.channelUtxo = {
            txid: selectedUtxo.txid,
            vout: selectedUtxo.vout
        };

        // Create the OP_RETURN payload
        let payload = "tl3";
        payload += Encoding.encodeTradeTokenForUTXO({
            ...params,
            // Include the reference address if needed
            referenceAddress: senderChannel // or another address if required
        });

        // Create the transaction with the channel address as the first input
        let rawTx = await client.cmd('createrawtransaction', [[{
            txid: params.channelUtxo.txid,
            vout: params.channelUtxo.vout
        }], []]);

        // Add the OP_RETURN payload
        rawTx = await addPayload(payload, rawTx);

        // Add a change output for the token seller
        rawTx = await setChange(params.sellerChangeAddress, params.sellerChangeAmount, rawTx);

        // Sign the transaction
        let signedTx = await client.cmd('signrawtransactionwithwallet', rawTx);

        // Return the partially constructed and signed raw transaction
        return signedTx;
    },

   async finalizeTradeTokenTx(initialRawTx, additionalParams) {
        // additionalParams might include additionalUtxos, buyerChangeAddress, referenceAddress, etc.

        // Add additional UTXO inputs for UTXO consideration
        let rawTx = await addInputs(additionalParams.additionalUtxos, initialRawTx);

        // Add a change output for the UTXO spender/buyer
        rawTx = await setChange(additionalParams.buyerChangeAddress, additionalParams.buyerChangeAmount, rawTx);

        // Add the reference output, ensuring it matches the address in the OP_RETURN payload
        // (Assuming the logic to add a standard output is similar to setChange)
        rawTx = await setChange(additionalParams.referenceAddress, additionalParams.referenceAmount, rawTx);

        // Re-sign the transaction to include the new inputs and outputs
        let signedTx = await client.cmd('signrawtransactionwithwallet', rawTx);

        // Return the fully constructed and signed raw transaction
        return signedTx;
    },


    async parseAndCoSignMultisigTransaction(rawTx, expectedUTXOValue, coSignerAddress, coSignerPrivateKey, network) {
        // Step 1: Decode the raw transaction
        const decodedTx = await TxUtils.decodeRawTransaction(rawTx, network);

        // Step 2: Analyze the transaction outputs to find the reference/payment address and its value
         // Step 2: Analyze the transaction outputs to find the reference/payment address and its value
    // The reference output is the last output before the OP_RETURN or null data output
        let paymentOutputIndex = decodedTx.vout.findIndex(output => output.scriptPubKey.type === 'nulldata');
        if (paymentOutputIndex === -1 || paymentOutputIndex === 0) {
            return new Error('No OP_RETURN output found or no outputs before OP_RETURN');
        }
        let paymentOutput = decodedTx.vout[paymentOutputIndex - 1]; // Getting the output before OP_RETURN

        if (!paymentOutput || paymentOutput.value < expectedUTXOValue) {
            return new Error('Transaction does not meet the expected UTXO value criteria');
        }

        // Step 3: If the transaction is valid, prepare to co-sign it
        // Fetch additional UTXOs for the coSignerAddress if necessary
        const additionalUTXOs = await TxUtils.getAdditionalUTXOs(coSignerAddress, expectedUTXOValue - paymentOutput.value, network);

        // Step 4: Add the additional UTXOs to the transaction
        rawTx = await TxUtils.addInputsToTransaction(rawTx, additionalUTXOs, network);

        // Step 5: Co-sign the transaction
        const coSignedTx = await TxUtils.coSignTransaction(rawTx, coSignerPrivateKey, network);

        // Step 6: Optionally, you can broadcast the transaction
        // const txId = await TxUtils.broadcastTransaction(coSignedTx, network);

        return coSignedTx; // Return the co-signed transaction
    },


    async issuePropertyTransaction(fromAddress, initialAmount, ticker, whitelists, managed, backupAddress, nft) {
        try {
            // Get private key for the fromAddress
            const privateKey = await dumpprivkeyAsync(fromAddress);

            // Find a suitable UTXO
            const minAmountSatoshis = STANDARD_FEE;
            const utxo = await TxUtils.findSuitableUTXO(fromAddress, minAmountSatoshis);

            // Create the transaction
            let transaction = new litecore.Transaction().from(utxo).fee(STANDARD_FEE);

            // Add change address
            transaction.change(fromAddress);

            // Prepare the payload for property issuance
            var payload = 'tl1'; // 'tl1' indicates property issuance
            payload += Encode.encodeTokenIssue({
                initialAmount: initialAmount,
                ticker: ticker,
                whitelists: whitelists,
                managed: managed,
                backupAddress: backupAddress,
                nft: nft
            });
            console.log('Preparing payload for property issuance:', payload);

            // Add OP_RETURN data
            transaction.addData(payload);

            // Sign the transaction
            transaction.sign(privateKey);

            // Serialize and send the transaction
            const serializedTx = transaction.serialize();
            const txid = await sendrawtransactionAsync(serializedTx);
            console.log('Property issuance transaction sent:', txid);
            return txid;
        } catch (error) {
            console.error('Error in issuePropertyTransaction:', error);
            throw error; // Rethrow the error for handling upstream
        }
    },
    
    async tokenTradeTransaction(fromAddress, propertyIdOffered, propertyIdDesired, amountOffered, amountExpected) {
        try {
                // Get private key for the fromAddress
                const privateKey = await dumpprivkeyAsync(fromAddress);

                // Find a suitable UTXO
                const minAmountSatoshis = STANDARD_FEE;
                const utxo = await TxUtils.findSuitableUTXO(fromAddress, minAmountSatoshis);

                // Create the transaction
                let transaction = new litecore.Transaction().from(utxo).fee(STANDARD_FEE);

                // Add change address
                transaction.change(fromAddress);

                // Prepare the payload for token trade
                var payload = 'tl5'; // 'tl5' indicates token-to-token trade
                payload += Encode.encodeOnChainTokenForToken({
                    propertyIdOffered: propertyIdOffered,
                    propertyIdDesired: propertyIdDesired,
                    amountOffered: amountOffered,
                    amountExpected: amountExpected
                });
                console.log('Preparing payload for token trade:', payload);

                // Add OP_RETURN data
                transaction.addData(payload);

                // Sign the transaction
                transaction.sign(privateKey);

                // Serialize and send the transaction
                const serializedTx = transaction.serialize();
                const txid = await sendrawtransactionAsync(serializedTx);
                console.log('Token trade transaction sent:', txid);
                return txid;
            } catch (error) {
                console.error('Error in tokenTradeTransaction:', error);
                throw error; // Rethrow the error for handling upstream
            }
        },

// Usage example
// issuePropertyTransaction('admin-address', 1000000, 'MyToken', [1, 2, 3], true, 'backup-address', false);

   async sendTransaction(fromAddress, toAddress, propertyId, amount, sendAll) {
        try {
            // Get private key for the fromAddress
            const privateKey = await dumpprivkeyAsync(fromAddress);
            if(sendAll==null){sendAll=0}

            // Find a suitable UTXO
            const minAmountSatoshis = STANDARD_FEE;
            const utxo = await TxUtils.findSuitableUTXO(fromAddress, minAmountSatoshis);

            // Create the transaction
            let transaction = new litecore.Transaction().from(utxo).fee(STANDARD_FEE);

            // Add change address
            transaction.change(fromAddress);

            // Add OP_RETURN data if provided
            var payload ='tl2'
            payload += Encode.encodeSend({'sendAll':sendAll,'address':toAddress,'propertyId':propertyId,'amount':amount})
            console.log('preparing paylaod '+payload)
            transaction.addData(payload);
       

            // Sign the transaction
            transaction.sign(privateKey);

            // Serialize and send the transaction
            const serializedTx = transaction.serialize();
            const txid = await sendrawtransactionAsync(serializedTx);
            console.log(txid)

            return txid;
        } catch (error) {
            console.error('Error in sendTransaction:', error);
            return error;
        }
    },

    async activationTransaction(adminAddress, txTypeToActivate) {
        try {
            // Step 1: Create the activation payload
            // Assuming activation payload format: 'activation:<txTypeToActivate>'
            var activationPayload = 'tl0'
            activationPayload += Encode.encodeActivateTradeLayer({'code':txTypeToActivate});

            // Step 2: Create a new transaction
            const utxos = await TxUtils.listUnspent(1, 9999999, [adminAddress]);
            console.log(utxos)
            if (!utxos || utxos.length === 0) {
                throw new Error('No UTXOs available for the admin address');
            }


            const minAmountSatoshis = STANDARD_FEE;

            // Select an UTXO to use
            const utxo = await TxUtils.findSuitableUTXO(adminAddress, minAmountSatoshis);
            const rawTx = new litecore.Transaction()
                .from(utxo)
                .addData(activationPayload)
                .change(adminAddress)
                .fee(STANDARD_FEE);

            // Step 3: Sign the transaction
            const privateKey = await dumpprivkeyAsync(adminAddress);
            rawTx.sign(privateKey);

            // Step 4: Serialize and send the transaction
            const serializedTx = rawTx.serialize();
            const txid = await sendrawtransactionAsync(serializedTx);
            
            console.log(`Activation transaction sent successfully. TXID: ${txid}`);
            return txid;
        } catch (error) {
            console.error('Error in sendActivationTransaction:', error);
            throw error;
        }
    },


    async createContractSeriesTransaction(thisAddress, contractParams) {
        try {
            // Step 1: Create the activation payload
            // Assuming activation payload format: 'activation:<txTypeToActivate>'
            var txNumber = 16
            var payload = 'tl' + txNumber.toString(36);
            payload += Encode.encodeCreateFutureContractSeries(contractParams);

            // Step 2: Create a new transaction
            const utxos = await TxUtils.listUnspent(1, 9999999, [thisAddress]);
            console.log(utxos)
            if (!utxos || utxos.length === 0) {
                throw new Error('No UTXOs available for the admin address');
            }


            const minAmountSatoshis = STANDARD_FEE;

            // Select an UTXO to use
            const utxo = await TxUtils.findSuitableUTXO(thisAddress, minAmountSatoshis);
            const rawTx = new litecore.Transaction()
                .from(utxo)
                .addData(payload)
                .change(thisAddress)
                .fee(STANDARD_FEE);

            // Step 3: Sign the transaction
            const privateKey = await dumpprivkeyAsync(thisAddress);
            rawTx.sign(privateKey);

            // Step 4: Serialize and send the transaction
            const serializedTx = rawTx.serialize();
            const txid = await sendrawtransactionAsync(serializedTx);
            
            console.log(`Activation transaction sent successfully. TXID: ${txid}`);
            return txid;
        } catch (error) {
            console.error('Error in sendActivationTransaction:', error);
            throw error;
        }
    },

    async commitTransaction(fromAddress, toAddress, propertyId, amount, privateKey) {
        try {
            // Create the transaction
            let transaction = new litecore.Transaction();

            // Add input UTXOs, fees, and change address
            const utxo = await findSuitableUTXO(fromAddress);
            transaction.from(utxo).fee(STANDARD_FEE).change(fromAddress);

            // Add the trade commitment as OP_RETURN data
            const payload = 'tl4' + + Encode.encodeTradeCommitment({ toAddress, propertyId, amount });
            transaction.addData(payload);

            // Sign the transaction
            transaction.sign(privateKey);

            return transaction; // Return the unsigned transaction
        } catch (error) {
            console.error('Error in commitTransaction:', error);
            throw error;
        }
    },


    async createGeneralTransaction(thisAddress, contractParams,txNumber) {
        try {
            // Step 1: Create the activation payload
            // Assuming activation payload format: 'activation:<txTypeToActivate>'
            var payload = 'tl' + txNumber.toString(36);
            payload += Encode.encodeCreateFutureContractSeries(contractParams);

            const minAmountSatoshis = STANDARD_FEE;

            // Select an UTXO to use
            const utxo = await TxUtils.findSuitableUTXO(thisAddress, minAmountSatoshis);
            const rawTx = new litecore.Transaction()
                .from(utxo)
                .addData(activationPayload)
                .change(thisAddress)
                .fee(STANDARD_FEE);

            // Step 3: Sign the transaction
            const privateKey = await dumpprivkeyAsync(thisAddress);
            rawTx.sign(privateKey);

            // Step 4: Serialize and send the transaction
            const serializedTx = rawTx.serialize();
            const txid = await sendrawtransactionAsync(serializedTx);
            
            console.log(`Activation transaction sent successfully. TXID: ${txid}`);
            return txid;
        } catch (error) {
            console.error('Error in sendActivationTransaction:', error);
            throw error;
        }
    },
    
    async createOracleTransaction(thisAddress, contractParams,txNumber) {
        try {
            // Step 1: Create the activation payload
            // Assuming activation payload format: 'activation:<txTypeToActivate>'
            var txNumber = 13
            var payload = 'tl' + txNumber.toString(36);
            payload += Encode.encodeCreateOracle(contractParams);


            const minAmountSatoshis = STANDARD_FEE;

            // Select an UTXO to use
            const utxo = await TxUtils.findSuitableUTXO(thisAddress, minAmountSatoshis);
            console.log('chosen utxo '+JSON.stringify(utxo))
            const rawTx = new litecore.Transaction()
                .from(utxo)
                .addData(payload)
                .change(thisAddress)
                .fee(STANDARD_FEE);

            // Step 3: Sign the transaction
            const privateKey = await dumpprivkeyAsync(thisAddress);
            rawTx.sign(privateKey);

            // Step 4: Serialize and send the transaction
            const serializedTx = rawTx.uncheckedSerialize();
            const txid = await sendrawtransactionAsync(serializedTx);
            
            console.log(`Create Oracle transaction sent successfully. TXID: ${txid}`);
            return txid;
        } catch (error) {
            console.error('Error in createOracleTransaction:', error);
            throw error;
        }
    },


    async publishDataTransaction(thisAddress, contractParams,txNumber) {
        try {
            // Step 1: Create the activation payload
            // Assuming activation payload format: 'activation:<txTypeToActivate>'
            var txNumber = 14
            var payload = 'tl' + txNumber.toString(36);
            payload += Encode.encodePublishOracleData(contractParams);

            const minAmountSatoshis = STANDARD_FEE;

            // Select an UTXO to use
            const utxo = await TxUtils.findSuitableUTXO(thisAddress, minAmountSatoshis);
            const rawTx = new litecore.Transaction()
                .from(utxo)
                .addData(payload)
                .change(thisAddress)
                .fee(STANDARD_FEE);

            // Step 3: Sign the transaction
            const privateKey = await dumpprivkeyAsync(thisAddress);
            rawTx.sign(privateKey);

            // Step 4: Serialize and send the transaction
            const serializedTx = rawTx.serialize();
            const txid = await sendrawtransactionAsync(serializedTx);
            
            console.log(`Oracle publish transaction sent successfully. TXID: ${txid}`);
            return txid;
        } catch (error) {
            console.error('Error in sendOracleTransaction:', error);
            throw error;
        }
    },


    async createContractOnChainTradeTransaction(thisAddress, contractParams,txNumber) {
        try {
            // Step 1: Create the activation payload
            // Assuming activation payload format: 'activation:<txTypeToActivate>'
            var txNumber = 18
            var payload = 'tl' + txNumber.toString(36);
            payload += Encode.encodeTradeContractOnchain(contractParams);



            const minAmountSatoshis = STANDARD_FEE;

            // Select an UTXO to use
            const utxo = await TxUtils.findSuitableUTXO(thisAddress, minAmountSatoshis);
            const rawTx = new litecore.Transaction()
                .from(utxo)
                .addData(payload)
                .change(thisAddress)
                .fee(STANDARD_FEE);

            // Step 3: Sign the transaction
            const privateKey = await dumpprivkeyAsync(thisAddress);
            rawTx.sign(privateKey);

            // Step 4: Serialize and send the transaction
            const serializedTx = rawTx.serialize();
            const txid = await sendrawtransactionAsync(serializedTx);
            
            console.log(`Activation transaction sent successfully. TXID: ${txid}`);
            return txid;
        } catch (error) {
            console.error('Error in sendContractTradeTransaction:', error);
            throw error;
        }
    },

    async createCancelTransaction(thisAddress, cancelParams,txNumber) {
        try {
            // Step 1: Create the activation payload
            // Assuming activation payload format: 'activation:<txTypeToActivate>'
            var txNumber = 6
            var payload = 'tl' + txNumber.toString(36);
            payload += Encode.encodeCancelOrder(cancelParams);



            const minAmountSatoshis = STANDARD_FEE;

            // Select an UTXO to use
            const utxo = await TxUtils.findSuitableUTXO(thisAddress, minAmountSatoshis);
            const rawTx = new litecore.Transaction()
                .from(utxo)
                .addData(payload)
                .change(thisAddress)
                .fee(STANDARD_FEE);

            // Step 3: Sign the transaction
            const privateKey = await dumpprivkeyAsync(thisAddress);
            rawTx.sign(privateKey);

            // Step 4: Serialize and send the transaction
            const serializedTx = rawTx.serialize();
            const txid = await sendrawtransactionAsync(serializedTx);
            
            console.log(`Activation transaction sent successfully. TXID: ${txid}`);
            return txid;
        } catch (error) {
            console.error('Error in sendContractTradeTransaction:', error);
            throw error;
        }
    },

    async createCommitTransaction(thisAddress, commitParams,txNumber) {
        try {
            // Step 1: Create the activation payload
            // Assuming activation payload format: 'activation:<txTypeToActivate>'
            var txNumber = 4
            var payload = 'tl' + txNumber.toString(36);
            payload += Encode.encodeCommit(commitParams);



            const minAmountSatoshis = STANDARD_FEE;

            // Select an UTXO to use
            const utxo = await TxUtils.findSuitableUTXO(thisAddress, minAmountSatoshis);
            const rawTx = new litecore.Transaction()
                .from(utxo)
                .addData(payload)
                .change(thisAddress)
                .fee(STANDARD_FEE);

            // Step 3: Sign the transaction
            const privateKey = await dumpprivkeyAsync(thisAddress);
            rawTx.sign(privateKey);

            // Step 4: Serialize and send the transaction
            const serializedTx = rawTx.serialize();
            const txid = await sendrawtransactionAsync(serializedTx);
            
            console.log(`Activation transaction sent successfully. TXID: ${txid}`);
            return txid;
        } catch (error) {
            console.error('Error in sendContractTradeTransaction:', error);
            throw error;
        }
    },

     async createWithdrawalTransaction(thisAddress, withdrawalParams,txNumber) {
        try {
            // Step 1: Create the activation payload
            // Assuming activation payload format: 'activation:<txTypeToActivate>'
            var txNumber = 21
            var payload = 'tl' + txNumber.toString(36);
            payload += Encode.encodeWithdrawal(withdrawalParams);



            const minAmountSatoshis = STANDARD_FEE;

            // Select an UTXO to use
            const utxo = await TxUtils.findSuitableUTXO(thisAddress, minAmountSatoshis);
            const rawTx = new litecore.Transaction()
                .from(utxo)
                .addData(payload)
                .change(thisAddress)
                .fee(STANDARD_FEE);

            // Step 3: Sign the transaction
            const privateKey = await dumpprivkeyAsync(thisAddress);
            rawTx.sign(privateKey);

            // Step 4: Serialize and send the transaction
            const serializedTx = rawTx.serialize();
            const txid = await sendrawtransactionAsync(serializedTx);
            
            console.log(`Activation transaction sent successfully. TXID: ${txid}`);
            return txid;
        } catch (error) {
            console.error('Error in sendContractTradeTransaction:', error);
            throw error;
        }
    },

    async createChannelContractTradeTransaction(thisAddress, params,txNumber) {
        try {
            // Step 1: Create the activation payload
            // Assuming activation payload format: 'activation:<txTypeToActivate>'
            var txNumber = 19
            var payload = 'tl' + txNumber.toString(36);
            payload += Encode.encodeTradeContractChannel(params);



            const minAmountSatoshis = STANDARD_FEE;

            // Select an UTXO to use
            const utxo = await TxUtils.findSuitableUTXO(thisAddress, minAmountSatoshis);
            const rawTx = new litecore.Transaction()
                .from(utxo)
                .addData(payload)
                .change(thisAddress)
                .fee(STANDARD_FEE);

            // Step 3: Sign the transaction
            const privateKey = await dumpprivkeyAsync(thisAddress);
            rawTx.sign(privateKey);

            // Step 4: Serialize and send the transaction
            const serializedTx = rawTx.serialize();
            const txid = await sendrawtransactionAsync(serializedTx);
            
            console.log(`Activation transaction sent successfully. TXID: ${txid}`);
            return txid;
        } catch (error) {
            console.error('Error in sendContractTradeTransaction:', error);
            throw error;
        }
    },

    async createChannelTokenTradeTransaction(thisAddress, params,txNumber) {
        try {
            // Step 1: Create the activation payload
            // Assuming activation payload format: 'activation:<txTypeToActivate>'
            var txNumber = 20
            var payload = 'tl' + txNumber.toString(36);
            payload += Encode.encodeTradeTokensChannel(params);



            const minAmountSatoshis = STANDARD_FEE;

            // Select an UTXO to use
            const utxo = await TxUtils.findSuitableUTXO(thisAddress, minAmountSatoshis);
            const rawTx = new litecore.Transaction()
                .from(utxo)
                .addData(payload)
                .change(thisAddress)
                .fee(STANDARD_FEE);

            // Step 3: Sign the transaction
            const privateKey = await dumpprivkeyAsync(thisAddress);
            rawTx.sign(privateKey);

            // Step 4: Serialize and send the transaction
            const serializedTx = rawTx.serialize();
            const txid = await sendrawtransactionAsync(serializedTx);
            
            console.log(`Activation transaction sent successfully. TXID: ${txid}`);
            return txid;
        } catch (error) {
            console.error('Error in sendContractTradeTransaction:', error);
            throw error;
        }
    },

    createLitecoinMultisigAddress(pubKey1, pubKey2) {
        const publicKeys = [
            new litecore.PublicKey(pubKey1),
            new litecore.PublicKey(pubKey2)
        ];

        const multisig = new litecore.Address(publicKeys, 2); // 2-of-2 multisig
        return multisig.toString();
    },

    async findSuitableUTXO(address, minAmount) {
        console.log(address)
        const utxos = await listUnspentAsync(0, 9999999, [address]);
        console.log(utxos)
        const suitableUtxo = utxos.find(utxo => (utxo.amount * COIN >= minAmount) && (utxo.amount * COIN >= DUST_THRESHOLD));
        console.log(suitableUtxo)
        if (!suitableUtxo) {
            return new Error('No suitable UTXO found.');
        }

        return {
            txId: suitableUtxo.txid,
            outputIndex: suitableUtxo.vout,
            address: suitableUtxo.address,
            script: suitableUtxo.scriptPubKey,
            satoshis: Math.round(suitableUtxo.amount * 1e8) // Convert LTC to satoshis
        };
    },

    decodeTransactionType (encodedPayload){
        // Implementation to decode the transaction type from the encoded payload
        // For example, if the transaction type is the first byte of the payload:
        const txType = parseInt(encodedPayload.substring(0, 2), 16);
        return txType;
    }

};

module.exports = TxUtils;