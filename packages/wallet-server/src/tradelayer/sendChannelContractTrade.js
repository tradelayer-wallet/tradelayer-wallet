const PropertyManager = require('./property.js');
const TallyMap = require('./tally.js');
const Logic = require('./logic.js');
const litecore = require('bitcore-lib-ltc');
const TxUtils = require('./txUtils');
const TxIndex = require('./txIndex.js')

async function executeTransaction() {
    const chainTip = await TxIndex.fetchChainTip();

    let params = {
        contractId: 1,
        price: 45000,
        amount: 1,
        columnAIsSeller: '1',
        expiryBlock: chainTip + 10,
        insurance: '0'
    };

    // Function to generate a random number within a range
    function randomNumber(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    var random = randomNumber(20000, 50000);
    console.log('creating contract channel trade - params: '+JSON.stringify(params))
    TxUtils.createChannelContractTradeTransaction('tltc1q7r6x4v67n8vnaftnz8pk33yvf9t9gpynuwdfgk', params, null);
}

// Call the async function
executeTransaction();

//tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8
//tltc1qpgenrwmg9hxgv23mnvd2t7085prjkge2xw7myz