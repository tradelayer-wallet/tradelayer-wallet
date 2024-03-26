const crypto = require('crypto');
const TxUtils = require('./txUtils.js')
// Function to create a random ticker
function createRandomTicker(length = 5) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

// Function to generate a random number within a range
function randomNumber(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Function to issue a random token
async function issueRandomToken() {
    const fromAddress = 'tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8'; 
    const initialAmount = randomNumber(1000, 1000000); // Random amount between 1,000 and 1,000,000
    const ticker = createRandomTicker();
    const whitelists = []; // Assuming no whitelists for simplicity
    const managed = false; // Managed flag set to false
    const backupAddress = 'LNmiS6p8z3KuHHx3q6Jf6x6TfcyptE68oP'; // Replace with an actual backup address
    const nft = true; // NFT flag set to false

    console.log(`Issuing a new token:
    - Ticker: ${ticker}
    - Initial Amount: ${initialAmount}`);

    try {
        const txid = await TxUtils.issuePropertyTransaction(fromAddress, initialAmount, ticker, whitelists, managed, backupAddress, nft);
        console.log(`Token issued successfully. Transaction ID: ${txid}`);
    } catch (error) {
        console.error('Error issuing token:', error);
    }
}

// Call the function to issue a random token
issueRandomToken();
