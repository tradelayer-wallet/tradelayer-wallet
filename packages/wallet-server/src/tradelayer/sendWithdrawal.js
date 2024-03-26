const PropertyManager = require('./property.js');
const TallyMap = require('./tally.js');
const Logic = require('./logic.js');
const litecore = require('bitcore-lib-ltc');
const TxUtils = require('./txUtils');

let params = {
	withdrawAll: 0,
    propertyId: 3,
    amount:500,
    column: 0,
    channelAddress:'tltc1q7r6x4v67n8vnaftnz8pk33yvf9t9gpynuwdfgk'
}
    //const { address, privateKey } = generateNewAddress();
    //console.log('Generated new address:', address);

// Function to generate a random number within a range
function randomNumber(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

var random = randomNumber(20000,50000)

    TxUtils.createWithdrawalTransaction('tltc1q7r6x4v67n8vnaftnz8pk33yvf9t9gpynuwdfgk',params,4)
//tltc1qpgenrwmg9hxgv23mnvd2t7085prjkge2xw7myz
//tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8
