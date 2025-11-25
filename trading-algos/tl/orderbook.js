const SellSwapper = require('./seller.js')
const BuySwapper = require('./buyer.js')
const BigNumber = require('bignumber.js')

class OrderbookSession {
    constructor(socket, myInfo, client,test) {
        console.log('initializing orderbook '+JSON.stringify(myInfo))
        this.socket = socket;
        this.myInfo = myInfo;
        this.client = client;
        this.test = test
        
        // Start the session and listen for various events
        this.startSession();
    }

    setInfo(myInfo){
        this.myInfo=myInfo
    }

    // Start the session and manage connection lifecycle
    startSession() {
        this.socket.on('connection', () => {
            console.log('Connected to the orderbook server.');
            this.subscribeToOrderbook();
        });

        this.socket.on('disconnect', () => {
            console.log('Disconnected from the orderbook server.');
            // Reconnection logic could be added here if necessary
        });

        this.handleOrderMatches();
        this.handleNewOrders();
        this.handleOrderUpdates();
        this.handleClosedOrders();
    }

    // Subscribe to orderbook updates after connection
    subscribeToOrderbook() {
        // Subscribe to specific assets or full orderbook
        this.socket.emit('subscribe', { event: 'update-orderbook', assets: ['LTC', 'BTC'] });
        console.log('Subscribed to orderbook data for assets: LTC, BTC.');

        // Listening for general orderbook updates
        this.socket.on('update-orderbook', (data) => {
            console.log('Orderbook Updated:', data);
            // You can update your local orderbook or UI here
        });
    }

    // Handle new orders
    handleNewOrders() {
        this.socket.on('new-order', (newOrderData) => {
            console.log('socket in new order '+JSON.stringify(this.socket)+' '+this.socket)
            console.log('New Order:', newOrderData);
            // You can update the UI or alert the user about new orders
        });

        this.socket.on('many-orders', (bulkOrdersData) => {
            console.log('Many Orders Received:', bulkOrdersData);
            // Handle bulk order updates (e.g., refreshing the full orderbook)
        });
    }

    // Handle updates to existing orders in the orderbook
    handleOrderUpdates() {
        this.socket.on('update-orderbook', (updateData) => {
            console.log('Orderbook Update:', updateData);
            // Handle any updates to the orderbook here
        });
    }

    // Handle order closing or cancellations
    handleClosedOrders() {
        this.socket.on('close-order', (orderUUID) => {
            console.log(`Order ${orderUUID} closed or canceled.`);
            // Remove the order from the UI or local state
        });
    }

   // Handle matched orders and initiate trade swaps
        handleOrderMatches() {
            this.socket.on('new-channel', async (swapConfig) => {
                const tradeInfo = swapConfig?.tradeInfo;
                console.log('inside handleOrderMatches on algo '+JSON.stringify(swapConfig))
                if (!tradeInfo?.buyer || !tradeInfo?.seller) {
                  return;
                }

                //console.log('swap config '+JSON.stringify(swapConfig))
                if(!swapConfig.tradeInfo.buyer||!swapConfig.tradeInfo.seller){return}
                try {
                    const { tradeInfo, isBuyer } = swapConfig; // Extract the relevant trade info and buyer/seller flag
                    const { buyer, seller, props, type } = tradeInfo; // Get buyer/seller info and trade properties
                    
                    console.log('new channel match '+JSON.stringify(swapConfig)+' trade info'+JSON.stringify(tradeInfo))
                    // Make sure the buyer/seller addresses are properly matched
                    console.log('my address'+this.myInfo.keypair.address, +' buyer.address '+buyer.keypair.address+' seller.address '+seller.keypair.address)
                    if(!this.myInfo.keypair.address){
                       const address =  await this.getUTXOBalances()
                       if(!address||!this.myInfo.keypair.address){console.log('houston we have a problem')}
                    }
                    if (this.myInfo.keypair.address === buyer.keypair.address){
                        console.log('Initiating Buy Swap...');
                        await this.initiateBuySwap(type, tradeInfo, buyer, seller);
                    } else if (this.myInfo.keypair.address === seller.keypair.address){
                        console.log('Initiating Sell Swap...'+this.myInfo.keypair.address+' '+seller.keypair.address);
                        await this.initiateSellSwap(type, tradeInfo, buyer, seller);
                    } else {
                        console.log('Address mismatch, cannot proceed with swap.');
                    }
                } catch (error) {
                    console.error('Error handling matched order:', error);
                }
            });
        }

        // Initialize buy swap
        async initiateBuySwap(typeTrade, tradeInfo, buyerInfo, sellerInfo) {
            try {
                const buySwapper = new BuySwapper(typeTrade, tradeInfo, buyerInfo, sellerInfo, this.client, this.socket,this.test);
                const res = await buySwapper.onReady();
                if (res.error) {
                    console.error(`Buy Swap Failed: ${res.error}`);
                } else {
                    console.log(`Buy Swap Complete: ${res.data}`);
                }
            } catch (error) {
                console.error('Error initiating Buy Swap:', error);
            }
        }

        // Initialize sell swap
        async initiateSellSwap(typeTrade, tradeInfo, buyerInfo, sellerInfo) {
            try {
                const sellSwapper = new SellSwapper(typeTrade, tradeInfo, sellerInfo, buyerInfo, this.client, this.socket,this.test);
                const res = await sellSwapper.onReady();
                if (res.error) {
                    console.error(`Sell Swap Failed: ${res.error}`);
                } else {
                    console.log(`Sell Swap Complete: ${res.data}`);
                }
            } catch (error) {
                console.error('Error initiating Sell Swap:', error);
            }
        }

        async getUTXOBalances(address) {
            try {
                const utxos = await this.listUnspent(); // Fetch sunspent transactions
                console.log('utxos returned 2nd pass in orderbook '+JSON.stringify(utxos))
                let totalBalance = new BigNumber(0);

                for (const utxo of utxos) {
                    console.log('scanning utxos '+utxo.address+' '+utxo.amount)
                    if (utxo.address === address){
                        totalBalance += utxo.amount; // Sum balances for the specific address
                    } else if (!this.myInfo.keypair.address){
                        this.myInfo.keypair.address = utxo.address;
                        this.myInfo.keypair.pubkey = await this.getPubKeyFromAddress(utxo.address); // Get pubkey for the new address
                        console.log('logging pubkey ' +this.myInfo.keypair.pubkey+' '+this.myInfo.keypair.address)
                        totalBalance += utxo.amount;
                    } else if (address === '' && this.myInfo.keypair.address){
                        const pubkey = await this.getPubKeyFromAddress(utxo.address);
                        this.myInfo.otherAddrs.push({ address: utxo.address, pubkey: pubkey });
                        totalBalance += utxo.amount;
                    }
                }

                console.log(`Total UTXO balance for address ${this.myInfo.keypair.address}:`, totalBalance);
                  
                return this.myInfo.keypair.address
            } catch (error) {
                console.error('Error fetching UTXO balances:', error);
            }
        }

        listUnspent(...params) {
            return util.promisify(this.client.cmd.bind(this.client, 'listunspent'))(...params);
        }

        async getPubKeyFromAddress(address) {
        try {
            const addressInfo = await this.getAddressInfo(address);
            if (addressInfo && addressInfo.pubkey) {
                return addressInfo.pubkey;
            } else {
                throw new Error('Public key not found for address');
            }
        } catch (error) {
            console.error('Error fetching pubkey:', error);
        }
    }
}

module.exports = OrderbookSession