const dbInstance = require('./db.js');

async function loadOrCreateOrderBook(orderBookKey) {
    const orderBooksDB = dbInstance.getDatabase('orderBooks');
    const orderBookData = await orderBooksDB.findOneAsync({ _id: orderBookKey });

    let orderBooks = {};

    if (orderBookData) {
        orderBooks[orderBookKey] = JSON.parse(orderBookData.value);
        console.log('Order book data:', JSON.stringify(orderBookData.value));
    } else {
        // If no data found, create a new order book
        orderBooks[orderBookKey] = { buy: [], sell: [] };
        console.log('No existing order book. Created new:', orderBooks[orderBookKey]);

        // Implement your saveOrderBook logic here if needed
    }

    return orderBooks[orderBookKey];
}

// Example usage
async function main() {
    const orderBookKey = '3-4'; // Replace with your actual order book key
    const data = await loadOrCreateOrderBook(orderBookKey);
    console.log('Loaded or created order book:', data);
}

main().catch(console.error);
/*
 // Adds a token order to the order book
    async addTokenOrder(order) {
        // Determine the correct orderbook key
        const normalizedOrderBookKey = this.normalizeOrderBookKey(order.offeredPropertyId, order.desiredPropertyId);
        console.log('Normalized Order Book Key:', normalizedOrderBookKey);

        // Create an instance of Orderbook for the pair and load its data
        const orderbook = new Orderbook(normalizedOrderBookKey);
        await orderbook.loadOrCreateOrderBook();

        // Determine if the order is a sell order
        const isSellOrder = order.offeredPropertyId < order.desiredPropertyId;

        // Add the order to the orderbook
        const orderConfirmation = await orderbook.insertOrder(order, isSellOrder);
        console.log('Order Insertion Confirmation:', orderConfirmation);

        // Match orders in the orderbook
        const matchResult = await orderbook.matchOrders();
        console.log('Match Result:', matchResult);

        // Save the updated orderbook back to the database
        await orderbook.saveOrderBook(normalizeOrderBookKey);

        return matchResult;
    }

    normalizeOrderBookKey(propertyId1, propertyId2) {
        // Ensure lower property ID is first in the key
        return propertyId1 < propertyId2 ? `${propertyId1}-${propertyId2}` : `${propertyId2}-${propertyId1}`;
    }*/