const PropertyManager = require('./property.js');
const TallyMap = require('./tally.js');
const Logic = require('./logic.js');
const litecore = require('bitcore-lib-ltc');
const TxUtils = require('./txUtils');
const TxIndex = require('./txIndex.js')

async function executeTransaction() {
    const chainTip = await TxIndex.fetchChainTip();

    let params = {
		propertyId1: 3,
	    propertyId2: 4,
	    amountOffered1: 100,
	    amountDesired2: 50,
	    expiryBlock:chainTip+10,
        columnAIsOfferer: 0
	}
    // Function to generate a random number within a range
    function randomNumber(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    var random = randomNumber(20000, 50000);

    TxUtils.createChannelTokenTradeTransaction('tltc1q7r6x4v67n8vnaftnz8pk33yvf9t9gpynuwdfgk', params, null);
}

// Call the async function
executeTransaction();


    //const { address, privateKey } = generateNewAddress();
    //console.log('Generated new address:', address);
