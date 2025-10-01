const ccxt = require('ccxt');
const ApiWrapper = require('tradelayer');
const axios = require('axios');
const WebSocket = require('ws');
const {apiKey, secret } = require('./keys.js')
const BigNumber = require('bignumber.js')
// Initialize Binance using CCXTconst ccxt = require('ccxt');
// Initialize Binance using CCXT
const binance = new ccxt.binance({
    apiKey: apiKey,
    secret: secret,
    enableRateLimit: true,
});

let inventory = {exchangeLTC:0,tlLTC:0,exchangeCash:0,tlCash:0}

// Initialize TradeLayer API

let myInfo = { address: 'tltc1qvlwcnwlhnja7wlj685ptwxej75mms9nyv7vuy8', otherAddrs: [] };
const api = new ApiWrapper('http://172.81.181.19', 3001, true,true,myInfo, 'LTCTEST');

let orderIds = []

// Define target exposure in LTC
const targetExposure = 1; // Example: 1 LTC
const cashPropertyId = 5
// WebSocket for Binance Spot BTC/USDT market data
const websocketUrl = 'wss://stream.binance.com:9443/ws';
const ws = new WebSocket(websocketUrl);

ws.on('open', () => {
    const subscriptionMessage = JSON.stringify({
        method: 'SUBSCRIBE',
        params: [
            'ltcusdt@depth'
        ],
        id: 1
    });
    ws.send(subscriptionMessage);
    console.log('Subscribed to btcusdt@aggTrade and btcusdt@depth');
});


// Variables for order tracking
let previousOrder = null;  // To track previous orders and cancel them

// Connect to Binance WebSocket
ws.on('message', (data) => {
    const orderBookData = JSON.parse(data);
     let bidPrice = null
    let askPrice = null
    try{
       
        if(!orderBookData||!orderBookData.b||!orderBookData.a){
                    console.log('orderBookData issue')
        }else{
            bidPrice = orderBookData.b[0][0] || null;
            askPrice = orderBookData.a[0][0] || null;
        }
        if(bidPrice!=null&&askPrice!=null){
                console.log('updating prices outside func '+bidPrice+askPrice)
        }
    }catch(err){
        console.log('err with incoming exchange data '+err)
    }
   
    // Adjust orders based on the orderbook data
    adjustOrders(bidPrice, askPrice);
});

// Fetch account balances from Binance
async function getBinanceAccountBalance() {
    try {
        const balance = await binance.fetchBalance();
        //console.log('Binance Account Balance:', balance);
        console.log('balance BTC, LTC '+balance.BTC+' '+balance.LTC)
        return balance;
    } catch (error) {
        console.error('Error fetching Binance account balance:', error);
    }
}

// Fetch token balances and UTXOs from TradeLayer
async function getTradeLayerBalances(address) {
    try {
        const tokenBalances = await api.getAllTokenBalancesForAddress(address);
        const utxoData = await api.getUTXOBalances(address);
        console.log(`TradeLayer Balances for ${address}:`, tokenBalances);
        console.log(`TradeLayer UTXOs for ${address}:`, utxoData);
        return { tokens: tokenBalances, LTC: utxoData };
    } catch (error) {
        console.error('Error fetching data from TradeLayer:', error);
    }
}

// Adjust orders based on market conditions
async function adjustOrders(bidPrice, askPrice) {
    const orderSide = 'buy';  // Example: Place buy orders for both platforms
    const amount = 0.1; // Amount to buy/sell

    if(bidPrice==null||askPrice==null){return}

    //try {
        try{
            if (previousOrder) {
                // Cancel the previous order
                await binance.cancelOrder("LTC/USDT", previousOrder.id);
                console.log(`Canceled previous order with ID: ${previousOrder.id}`);
            }
        }catch(error){
            console.log('error canceling on Binance '+error)
        }


        const tlBid = new BigNumber(bidPrice).times(0.999925).toNumber()
        const tlAsk = new BigNumber(askPrice).times(1.000075).toNumber()
        const tlBid2 = new BigNumber(bidPrice).times(0.99985).toNumber()
        const tlAsk2 = new BigNumber(askPrice).times(1.000125).toNumber() 

        orderIds = api.getOrders() 

        //console.log("My Orders: ", orderIds);  // Debug log to check structure


        console.log('tl order ids length '+orderIds.length)

        if(orderIds.length>0){
            for (let i = 0; i < orderIds.length; i++){
                let order = orderIds[i]
                //console.log('showing element in myOrders' +JSON.stringify(order))
                if(order.details!=undefined){
                    //console.log('checking orders to cancel '+order.details.action+' '+order.details.props.price)
                    if((order.details.action=="BUY"&&order.details.props.price>tlBid)||(order.details.action=="SELL"&&order.details.props.price<tlAsk)){
                         api.cancelOrder(order.id)
                    }
                }else{
                     //orderIds.pop(id)
                    console.log('Orders coming in undefined, check socket connection '+JSON.stringify(id))
                    //console.log('order Ids post removal '+orderIds.length)
                }
            }
        }
       
        // Place two orders on TradeLayer
        const tradeLayerOrders = [
            {
                type: 'SPOT',
                action: 'BUY',
                props: { id_for_sale: 0, id_desired: cashPropertyId, price: tlBid, amount: amount, transfer: false }
            },
            {
                type: 'SPOT',
                action: 'SELL',
                props: { id_for_sale: cashPropertyId, id_desired: 0, price: tlAsk, amount: amount, transfer: false }
            },
            {
                type: 'SPOT',
                action: 'BUY',
                props: { id_for_sale: 0, id_desired: cashPropertyId, price: tlBid2, amount: amount, transfer: false }
            },
            {
                type: 'SPOT',
                action: 'SELL',
                props: { id_for_sale: cashPropertyId, id_desired: 0, price: tlAsk2, amount: amount, transfer: false }
            }
        ];

        console.log('tl Orders '+JSON.stringify(tradeLayerOrders))

        for (let orderDetails of tradeLayerOrders) {
            try{
                const orderUUID = await api.sendOrder(orderDetails);
                //orderIds.push({details: orderDetails,id:orderUUID})
                console.log('Order sent on TradeLayer, UUID:', orderUUID);
                previousOrder = orderUUID;  // Store the order for potential cancellation
            }catch(err){
                console.log('err with tl order '+err)
            }            
        }

        // Now place a corresponding hedge on Binance (opposite of what was placed on TradeLayer)
        const binanceOrders = [
            {
                symbol: 'LTC/USDT',
                type: 'MARKET',
                side: 'sell', // Hedge the buy order on TradeLayer by selling on Binance
                //price: bidPrice,
                amount: amount,
            },
            {
                symbol: 'LTC/USDT',
                type: 'MARKET',
                side: 'buy', // Hedge the sell order on TradeLayer by buying on Binance
                //price: askPrice,
                amount: amount,
            }
        ];

        // Place corresponding hedge orders on Binance
            for (let orderParams of binanceOrders) {
                try{
                    const newOrder = await binance.createOrder(orderParams.symbol, orderParams.type, orderParams.side, orderParams.amount, orderParams.price);
                    console.log('Placed hedge order on Binance:', newOrder);
                }catch(err){
                    console.log('error posting Binance order '+err)
                }
                
            }

        //} catch (error) {
        //    console.error('Error adjusting orders:', error);
        //}
    }

// Main loop for the Market Maker Bot
async function marketMakingLoop() {
    try {
        // Start by fetching initial data
        await getBinanceAccountBalance();
        await getTradeLayerBalances(myInfo.address);

        // Every 10 seconds, check and update target exposure
        setInterval(async () => {
            await manageTargetExposure();
        }, 500);

        // Start the WebSocket connection to Binance and adjust orders based on market conditions
        /*ws.on('message', async (data) => {
            const orderBookData = JSON.parse(data);
            console.log('ws ping '+Date.now())
            //console.log('orderBookData '+JSON.stringify(orderBookData))
            let bidPrice = null
            let askPrice = null

            if(!orderBookData||!orderBookData.b||!orderBookData.a){
                console.log('orderBookData issue')
            }else if(){
                bidPrice = orderBookData.b[0][0] || null;
                askPrice = orderBookData.a[0][0] || null;
            }
            if(bidPrice!=null&&askPrice!=null){
                console.log('updating prices '+bidPrice+' ' +askPrice)
                await adjustOrders(bidPrice, askPrice);
            }
        });*/

    } catch (error) {
        console.error('Error in market-making loop:', error);
    }
}

// Function to manage target exposure (balances)
async function manageTargetExposure() {
    const binanceBalance = await getBinanceAccountBalance();
    const tradeLayerData = await getTradeLayerBalances(myInfo.address);

    inventory.exchangeLTC = binanceBalance.total.LTC;
    inventory.exchangeCash = binanceBalance.total.USDT
    //console.log('tradelayer Data '+JSON.stringify(tradeLayerData))
    if(tradeLayerData!=undefined&&tradeLayerData.LTC!=undefined){
        inventory.tlLTC = tradeLayerData.LTC || 0;
    }

    if(tradeLayerData!=undefined&&tradeLayerData.tokenBalances!=undefined){
        for(const property in tradeLayerData.tokenBalances){
            if(property.propertyId==cashPropertyId){
                inventory.tlCash=property.amount
            }
        }
    }
    
    // Check if exposure is off-target, and adjust positions
    if (inventory.exchangeLTC < targetExposure) {
        const deficit = targetExposure - inventory.exchangeLTC;
        console.log(`Target exposure not met, buying ${deficit} LTC from Binance`);
        // Place a buy order on Binance
        //adjustOrders(deficit);
    } else if (inventory.tlLTC < targetExposure) {
        const deficit = targetExposure - inventory.tlLTC;
        console.log(`Target exposure not met, buying ${deficit} LTC from TradeLayer`);
        // Place a buy order on TradeLayer (Add your logic here)
    } else {
        console.log('Target exposure met.');
    }
}

// Run the market-making loop
api.delay(6000)
marketMakingLoop();
