const fetch = require('node-fetch');
const { publishDataTransaction } = require('./txUtils.js');

const BTC_PRICE_API_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'; // Example URL

async function fetchBTCPrice() {
    try {
        const response = await fetch(BTC_PRICE_API_URL);
        const data = await response.json();
        return data.bitcoin.usd; // Assuming the price is in this path
    } catch (error) {
        console.error('Error fetching BTC price:', error);
        throw error;
    }
}

async function publishBTCPrice() {
    const btcPrice = await fetchBTCPrice();
    const contractParams = {oracleid: 1, price: 51950}; // Format as required
    const thisAddress = 'tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8'; // Your address
    await publishDataTransaction(thisAddress, contractParams);
}

publishBTCPrice(); // Publish every 60 seconds
