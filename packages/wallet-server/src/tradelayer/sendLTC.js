const async = require('async');
const util = require('util');
const litecore = require('bitcore-lib-ltc');
const Encode = require('./txEncoder.js');
const litecoin = require('litecoin');

const clientConfig = /*test ?*/ {
            host: '127.0.0.1',
            port: 18332,
            user: 'user',
            pass: 'pass',
            timeout: 10000
        }

const client = new litecoin.Client(clientConfig);
// Assuming standard fee and other constants are defined
const STANDARD_FEE = 10000; // Standard fee in satoshis
const DUST_THRESHOLD = 54600;

// Promisify client functions
const listUnspentAsync = util.promisify(client.cmd.bind(client, 'listunspent'));
const dumpprivkeyAsync = util.promisify(client.cmd.bind(client, 'dumpprivkey'));
const sendrawtransactionAsync = util.promisify(client.cmd.bind(client, 'sendrawtransaction'));

async function sendLitecoin(senderAddress, recipientAddress, amountToSend) {
    try {
        // Fetch the private key for the sender address
        const privateKeyWIF = await dumpprivkeyAsync(senderAddress);
        const privateKey = new litecore.PrivateKey.fromWIF(privateKeyWIF);

        // Fetch UTXOs for the sender address
        const utxos = await listUnspentAsync(1, 9999999, [senderAddress]);
        if (!utxos || utxos.length === 0) {
            throw new Error('No UTXOs available for the sender address');
        }

        // Create a new transaction
        const tx = new litecore.Transaction()
            .from(utxos)
            .to(recipientAddress, 10000000)
            .change(senderAddress)
            .fee(STANDARD_FEE)
            .sign(privateKey);

        // Serialize and broadcast the transaction
        const serializedTx = tx.serialize();
        const txid = await sendrawtransactionAsync(serializedTx);
        console.log(`Transaction sent successfully. TXID: ${txid}`);
    } catch (error) {
        console.error('Error sending Litecoin:', error);
    }
}

// Replace with actual values
const senderAddress = "tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8";
const recipientAddress = "tltc1qpgenrwmg9hxgv23mnvd2t7085prjkge2xw7myz"
//tltc1q7r6x4v67n8vnaftnz8pk33yvf9t9gpynuwdfgk";
const amountToSend = 0.1; // Amount of LTC to send

// Execute the function to send Litecoin
sendLitecoin(senderAddress, recipientAddress, amountToSend);
