const crypto = require('crypto');
const TxUtils = require('./txUtils.js'); // Assuming TxUtils contains the necessary transaction utility functions

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

// Function to create an oracle and then issue a contract
async function createOracleAndIssueContract() {
    const adminAddress = 'tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8'; // Replace with the actual admin address
    const backupAddress = 'LNmiS6p8z3KuHHx3q6Jf6x6TfcyptE68oP'; // Replace with an actual backup address

    // Create Oracle Parameters
    const oracleTicker = "BTC/USD";
    const oracleUrl = "bravenewcoin.com";

    // Create Contract Series Parameters
    const contractSeriesTicker = "BTC/USD-BLX";
    const underlyingOracleId = 1; // Placeholder, replace with actual oracle ID after creation
    const notionalPropertyId = null; // Random property ID for testing
    const collateralPropertyId = 3; // Random collateral property ID for testing
    const leverage = 10; // Example leverage
    const expiryPeriod = 17532; // Example expiry period
    const series = 5; // Number of contracts in the series

    console.log(`Creating an oracle: ${oracleTicker}`);

    try {
        // Create Oracle
        const oracleTxId = await TxUtils.createOracleTransaction(adminAddress, {
            ticker: oracleTicker,
            url: oracleUrl,
            backupAddress: backupAddress,
            whitelists: [],
            lag: 1
        }, 13);

        console.log(`Oracle created successfully. Transaction ID: ${oracleTxId}`);

        // Wait for oracle creation to be confirmed before issuing the contract
        // This is just a placeholder, you should implement a proper wait/check mechanism
        console.log('Waiting for oracle confirmation...');
        await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds delay
}

// Call the function to create an oracle and issue a contract
createOracleAndIssueContract();
