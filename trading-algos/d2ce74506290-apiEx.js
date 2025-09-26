const ApiWrapper = require('tradelayer');
let myInfo = {address:'tltc1qh4se4w23draju8ef82vdvelz3zj8egflrg2gve',otherAddrs:[]};
const api = new ApiWrapper('ws://172.81.181.19', 3001, true,true, myInfo, 'LTCTEST');

// Start listening for order matches and handle swaps
let orderbookSession = []
let savedOrderUUIDs = []; // Array to store UUIDs of orders


async function performTradeOperations(testAddress) {
      console.log("awaiting init and address load")
        await api.delay(6000);
            myInfo = api.getMyInfo()


// Call getTokenBalances with your test address
console.log('checking we have address loaded before tokenBalances load '+myInfo.keypair.address)
const tokenBalances = await api.getAllTokenBalancesForAddress(myInfo.keypair.address);
console.log('tokens '+JSON.stringify(tokenBalances))
// Example of fetching spot markets
api.getSpotMarkets()
    .then(markets => console.log('Spot Markets:', markets))
    .catch(error => console.error('Error:', error));

api.getFuturesMarkets()
    .then(markets => console.log('Futures Markets:', markets))
    .catch(error => console.error('Error:', error));

// Example of sending an order
const orderDetails = {
    type: 'SPOT',
    action: 'BUY',
    props: { id_for_sale: 0, id_desired:1, price: 0.0003, amount: 0.3, transfer: false }
};

await api.delay(3000) 
api.sendOrder(orderDetails)
    .then(orderUUID => {
        console.log('Order sent, UUID:', orderUUID+' '+ JSON.stringify(orderDetails));
        
        savedOrderUUIDs.push({id: orderUUID, details: orderDetails}); // Save UUID to the array
    })
    console.log('delay and test cancel')
    
    console.log(JSON.stringify(savedOrderUUIDs))
    /*console.log('about to cancel this order '+savedOrderUUIDs[0].id)
    api.cancelOrder(savedOrderUUIDs[0].id)
                .then(response => {
                    savedOrderUUIDs = savedOrderUUIDs.filter(order => order.id !== savedOrderUUIDs[0].id);
                    console.log(`Order with UUID: ${orderToCancel} canceled successfully!`);
                })*/

// Example of getting orderbook data
const filter = { type: 'SPOT', first_token: 0, second_token: 1 };
api.getOrderbookData(filter)
    .then(orderbookData => console.log('Orderbook Data:', orderbookData))
    .catch(error => console.error('Error fetching orderbook data:', error));
}

// Example usage of the function
performTradeOperations(myInfo.address);
