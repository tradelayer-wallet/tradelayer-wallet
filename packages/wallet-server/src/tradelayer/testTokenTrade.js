const TxUtils = require('./TxUtils'); // Import your TxUtils class

async function runTestTokenTrades() {
    // Define some sample data for testing
    const testAdminAddress = 'tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8'; // Replace with actual admin address

    // Sample data for token trades
    const trades = [
        { offeredPropertyId: 3, desiredPropertyId: 4, amountOffered: 25, amountExpected: 53 }
    ];

    // Iterate over each trade and create a transaction
    for (let trade of trades) {
        try {
            console.log(`Creating trade: Offered Property ID ${trade.offeredPropertyId}, Desired Property ID ${trade.desiredPropertyId}`);
            const txId = await TxUtils.tokenTradeTransaction(
                testAdminAddress,
                trade.offeredPropertyId,
                trade.desiredPropertyId,
                trade.amountOffered,
                trade.amountExpected
            );
            console.log(`Transaction ID: ${txId}`);
        } catch (error) {
            console.error(`Error creating trade for offered property ${trade.offeredPropertyId} and desired property ${trade.desiredPropertyId}:`, error);
        }
    }
}

runTestTokenTrades()
    .then(() => console.log('Test token trade transactions completed.'))
    .catch(error => console.error('Error running test token trades:', error));
