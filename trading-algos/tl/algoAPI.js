const io = require('socket.io-client');
const axios = require('axios')
const util = require('util'); // Add util to handle logging circular structures
const BigNumber = require('bignumber.js');
const OrderbookSession = require('./orderbook.js');  // Add the session class
let orderbookSession={}
const {createLitecoinClient, createBitcoinClient} = require('./client.js');
const walletListener = require('./tradelayer.js/src/walletInterface.js');
const { createTransport } = require('./ws-transport');


class ApiWrapper {
    constructor(baseURL, port,test,tlAlreadyOn=false,address,pubkey,network) {
        console.log('constructing API wrapper' +port+' test?'+test+' tlOn? '+tlAlreadyOn)
        this.baseURL = baseURL;
        this.port = port;
        this.apiUrl = `${this.baseURL}:${this.port}`;
        this.socket = null;
        const netloc = baseURL.replace(/^ws:\/\/|^wss:\/\//, '').replace(/^http:\/\/|^https:\/\//, '');
        this.apiUrl = `http://${netloc}:${port}`;  // REST endpoint
        this.wsUrl  = `ws://${netloc}:${port}/ws`; // WS endpoint  // Create an instance of your TxService
        this.network = network
        this.myInfo = {address: address, keypair:{address: address, pubkey: pubkey}};  // Add buyer/seller info as needed
        this.myInfo.otherAddrs = []
        this.client = network && network.toUpperCase().startsWith('BTC')
    ? createBitcoinClient(test)
    : createLitecoinClient(test); // Use a client or wallet service instance
        this.test = test
        this.channels = {}
        this.myOrders = []
        this.initUntilSuccess(tlAlreadyOn)
    }


    // Function to initialize a socket connection
    _initializeSocket() {
            this.socket = createTransport({ type: 'ws', url: this.wsUrl });
            this.socket.connect(this.wsUrl).then(() => {
                console.log(`Connected to Orderbook Server via WS event-bus`);
                this.myInfo.socketId = null; // Not used in event-bus
                orderbookSession = new OrderbookSession(this.socket, this.myInfo, this.client, this.test);
            });
        // Listen for connection success
        this.socket.on('connect', () => {
            console.log(`Connected to Orderbook Server with ID: ${this.socket.id}`);
            this.myInfo.socketId = this.socket.id;
            orderbookSession = new OrderbookSession(this.socket, this.myInfo, this.client, this.test);
            // Save the socket id to this.myInfo            
        });

        /*this.socket.on('message', (raw) => {
            try { console.log('[WS][raw]', typeof raw === 'string' ? raw : JSON.stringify(raw)); }
            catch (_) {}
        });*/

        // Listen for disconnect events
        this.socket.on('disconnect', (reason) => {
            console.log(`Disconnected: ${reason}`);
        });

        // Listen for order save confirmation
        this.socket.on('order:saved', (orderUuid) => {
            this.myOrders.push()
            console.log(`Order saved with UUID: ${orderUuid}`);
        });

        this.socket.on('order:canceled', (confirmation) => {
                console.log('order canceled with id '+orderUuid)
                this.myOrders.filter(order => order.id !== orderUuiD);
                resolve(confirmation);
        });

        // Listen for order errors
        this.socket.on('order:error', (error) => {
            //console.error('Order error:', error);
        });

        // Listen for orderbook data updates
        this.socket.on('orderbook-data', (data) => {
            //console.log('Orderbook Data:', data);
        });
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

     async initUntilSuccess(tlOn) {
        console.log('inside initUntilSuccess '+tlOn)
        if(tlOn){
            console.log('init without wallet listener await')
            await this.init(this.myInfo.address)
            return
        }else{
            await this.delay(2000) 
            try {
                const response = await walletListener.initMain()
               // Assuming the response contains a 'success' field
                //console.log('Init response:', response.data);
                await this.init()
                return
            } catch (error) {
                console.error('Error during init:', error.response ? error.response.data : error.message);
                await new Promise(resolve => setTimeout(resolve, 15000)); // Wait before retrying
            }
        }
    }

    // Initialize function to check blockchain status
     async init() {
        try {
            const response = await this.getBlockchainInfo(); // Use your client to fetch blockchain info
            console.log('Blockchain Info:', response.blocks);
            // Check if initial block download is complete

            if (!response.initialblockdownload) {
                console.log('Block indexing is complete. Calling wallet listener init.');
                //await walletListener.initMain(); // Call initMain from walletListener
                await this.getUTXOBalances(this.myInfo.address)
                if(!this.socket){
                    this._initializeSocket()
                }
            }else{
                this.delay(10000)
                return this.init()
            }

            return {
                success: !response.initialblockdownload,
                message: response.initialblockdownload ? 'Block indexing is complete.' : 'Block indexing is still in progress.'
            };
        } catch (error) {
            console.error('Initialization error:', error);
            return {
                success: false,
                message: error.message
            };
        }
    }

async getUTXOBalances(address) {
    //console.log('address in get balances ' + address);
    try {
        const utxos = await this.listUnspent(1, 9999999, [address]);
        const unconfirmedUtxos = await this.getUnconfirmedTransactions(address);

        let totalBalance = new BigNumber(0); // Initialize BigNumber for total balance

        // Process confirmed UTXOs
        for (const utxo of utxos) {
            console.log('scanning utxos ' + utxo.address + ' ' + utxo.amount);
            const utxoAmount = new BigNumber(utxo.amount);
            if (utxo.address === address && this.myInfo.keypair.pubkey) {
                totalBalance = totalBalance.plus(utxoAmount); // Add balance for the specific address
            } else if (!this.myInfo.keypair.address || !this.myInfo.keypair.pubkey) {
                this.myInfo.keypair.address = utxo.address;
                this.myInfo.keypair.pubkey = await this.getPubKeyFromAddress(utxo.address);
                console.log('logging pubkey ' + this.myInfo.keypair.pubkey + ' ' + this.myInfo.keypair.address);
                totalBalance = totalBalance.plus(utxoAmount);
                this._initializeSocket();
            } else if (address === '' && this.myInfo.keypair.address) {
                const pubkey = await this.getPubKeyFromAddress(utxo.address);
                this.myInfo.otherAddrs.push({ address: utxo.address, pubkey: pubkey });
                totalBalance = totalBalance.plus(utxoAmount);
            }
        }

        // Process unconfirmed UTXOs
        if (unconfirmedUtxos.length > 0) {
            for (const utxo of unconfirmedUtxos) {
                console.log('scanning mempool utxos ' + utxo.address + ' ' + utxo.amount);
                const utxoAmount = new BigNumber(utxo.amount);
                if (utxo.address === address) {
                    totalBalance = totalBalance.plus(utxoAmount); // Add balance for the specific address
                } else if (!this.myInfo.keypair.address && this.myInfo.keypair.pubkey) {
                    this.myInfo.keypair.address = utxo.address;
                    this.myInfo.keypair.pubkey = await this.getPubKeyFromAddress(utxo.address);
                    console.log('logging pubkey ' + this.myInfo.keypair.pubkey + ' ' + this.myInfo.keypair.address);
                    totalBalance = totalBalance.plus(utxoAmount);
                    this._initializeSocket();
                } else if (address === '' && this.myInfo.keypair.address) {
                    const pubkey = await this.getPubKeyFromAddress(utxo.address);
                    this.myInfo.otherAddrs.push({ address: utxo.address, pubkey: pubkey });
                    totalBalance = totalBalance.plus(utxoAmount);
                }
            }
        }

        //console.log(`Total UTXO balance for address ${this.myInfo.keypair.address}:`, totalBalance.toString());
        return totalBalance.toNumber(); // Return the balance as a string to preserve precision
    } catch (error) {
        console.error('Error fetching UTXO balances:', error);
    }
}


    async checkIfAddressInWallet(address){
        try {
            // Check if the address is part of the wallet
            const addressInfo = await this.getAddressInfo(address);

            // Log the result to verify
            //console.log("Address Info:", JSON.stringify(addressInfo, null, 2));

            // Return whether the address is part of the wallet
            return addressInfo.ismine; // true if the address is in the wallet
        } catch (error) {
            console.error("Error checking if address is in wallet:", error);
            return false; // Return false if there's an error
        }
    };

    async getUnconfirmedTransactions(address) {
        try {
            // Get all unconfirmed transactions from the mempool
            const rawMempool = await this.getRawMempoolAsync(false);
            const transactionsWithAddress = [];

            for (const txid of rawMempool) {
                // Fetch detailed information for each transaction
                const txDetails = await this.getRawTransaction(txid, true);
                // Iterate through each output (vout) of the transaction
                for (const output of txDetails.vout) {
                    // Ensure output.scriptPubKey and addresses exist
                    if (output.scriptPubKey && Array.isArray(output.scriptPubKey.addresses)) {
                        const addresses = output.scriptPubKey.addresses;

                        if (!address) {
                            // If no specific address is provided, check if the address belongs to the wallet
                            const isMine = await this.checkIfAddressInWallet(addresses[0]);
                            if (isMine) {
                                console.log('Adding mempool tx to log', addresses[0], txid);
                                transactionsWithAddress.push({
                                    txid,
                                    vout: output.n,
                                    amount: output.value,
                                    address: addresses[0],
                                });
                            }
                        } else if (addresses.includes(address)) {
                            // If a specific address is provided, match it directly
                            transactionsWithAddress.push({
                                txid,
                                vout: output.n,
                                amount: output.value,
                                address: addresses[0],
                            });
                        }
                    }
                }
            }

            return transactionsWithAddress;
        } catch (error) {
            console.error('Error fetching unconfirmed transactions:', error.message || error);
            return [];
        }
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

  getBlockchainInfo() {
    return util.promisify(this.client.cmd.bind(this.client, 'getblockchaininfo'))();
  }

  getRawTransaction(txId, verbose = true, blockHash) {
    return util.promisify(this.client.cmd.bind(this.client, 'getrawtransaction'))(txId, verbose);
  }

  getRawMempoolAsync(verbose = true,) {
    return util.promisify(this.client.cmd.bind(this.client, 'getrawmempool'))(verbose);
  }

   getAddressInfo(address) {
    return util.promisify(this.client.cmd.bind(this.client, 'getaddressinfo'))(address);
  }


  getNetworkInfo(){
    return util.promisify(this.client.cmd.bind(this.client, 'getnetworkinfo'))()
  }

  getTransaction(txId) {
    return util.promisify(this.client.cmd.bind(this.client, 'gettransaction'))(txId);
  }

  getBlock(blockHash) {
    return util.promisify(this.client.cmd.bind(this.client, 'getblock'))(blockHash);
  }

  getBlockHash(height) {
    return util.promisify(this.client.cmd.bind(this.client, 'getblockhash'))(height);
  }

  createRawTransaction(...params) {
    return util.promisify(this.client.cmd.bind(this.client, 'createrawtransaction'))(...params);
  }

  listUnspent(minConf = 1, maxConf = 9999999, addresses = []) {
        return util.promisify(this.client.cmd.bind(this.client, 'listunspent'))(minConf, maxConf, addresses);
    }


  decoderawtransaction(...params) {
    return util.promisify(this.client.cmd.bind(this.client, 'decoderawtransaction'))(...params);
  }

  signrawtransactionwithwallet(...params) {
    return util.promisify(this.client.cmd.bind(this.client, 'signrawtransactionwithwallet'))(...params);
  }

  dumpprivkey(...params) {
    return util.promisify(this.client.cmd.bind(this.client, 'dumpprivkey'))(...params);
  }

  sendrawtransaction(...params) {
    return util.promisify(this.client.cmd.bind(this.client, 'sendrawtransaction'))(...params);
  }

  validateAddress(...params) {
    return util.promisify(this.client.cmd.bind(this.client, 'validateaddress'))(...params);
  }

  getBlockCount() {
      return util.promisify(this.client.cmd.bind(this.client, 'getblockcount'))();
  }

  loadWallet(...params) {
    return util.promisify(this.client.cmd.bind(this.client, 'loadwallet'))(...params);
  }


    async startOrderbookSession() {
        // Initialize an OrderbookSession when the socket connects
        this.orderbookSession = new OrderbookSession(this.socket, this.myInfo, this.txsService, this.client);
    }

    async getAllTokenBalancesForAddress(address){
        //console.log('address before calling wallet interface '+address)
        const tokens = await walletListener.getAllBalancesForAddress(address)
        return tokens
    }

    async getAllUTXOsForAddress(address){
        try {
        // Fetch the unspent outputs for the given address
        return await client.cmd('listunspent', 0, 9999999, [address]);
        } catch (error) {
            console.error('Error in getAllBalancesForAddress:', error.message || error);
            throw error;
        }
    }

    async getOnChainSpotOrderbook(id1, id2){
        return await walletListener.getOrderBook({id1,id2})
    }

    async getOnChainContractOrderbook(id){
        return await walletListener.getContractOrderBook({id})
    }

    async getPosition(address, contractId) {
       return await walletListener.getContractPositionForAddressAndContractId({address,contractId})
    }

    async getFundingHistory(contractId){
        return await walletListener.getFundingHistory(contractId)
    }

    // Emit a new order
    sendOrder(orderDetails) {
        console.log('sending order')
        if(this.socket){
            if (!orderDetails.keypair) {
            orderDetails.keypair = this.myInfo.keypair;
            }
            orderDetails.isLimitOrder = true;
            console.log(JSON.stringify(orderDetails))
            return new Promise((resolve, reject) => {
                this.socket.emit('new-order', orderDetails);
                this.socket.once('order:saved', (orderUuid) => {
                    console.log('saving order '+JSON.stringify({details: orderDetails, id: orderUuid }))
                    this.myOrders.push({details: orderDetails, id: orderUuid })
                    resolve(orderUuid);
                });
                this.socket.once('order:error', (error) => {
                    console.log('making note of err with order '+orderUUID)
                    //this.myOrders.push({details: orderDetails, id: orderUUID })
                    reject(error);
                });
            });
        }else{
            console.log('Still loading orderbook server socket session')
               // Return a rejected Promise to ensure the caller handles it
        return Promise.reject(new Error('Socket is not connected.'));
        }        
    }

    sendManyOrders(orderDetailsArray) {
        if (this.socket != undefined || this.socket != null) {
            // Add common metadata to all orders
            const ordersWithMeta = orderDetailsArray.map((orderDetails) => ({
                ...orderDetails,
                keypair: this.myInfo.keypair,
                isLimitOrder: true,
            }));

            return new Promise((resolve, reject) => {
                this.socket.emit('many-orders', ordersWithMeta);

                // Listen for the "order:saved" event for confirmation
                this.socket.once('order:saved', () => {
                    console.log('Batch of orders saved successfully');
                    this.myOrders.push(...ordersWithMeta); // Save orders locally
                    resolve(ordersWithMeta); // Resolve with the array of orders
                });

                // Handle errors for the batch
                this.socket.once('order:error', (error) => {
                    console.error('Error saving batch of orders:', error);
                    reject(error);
                });
            });
        } else {
            console.log('Still loading orderbook server socket session');
            // Return a rejected Promise to ensure the caller handles it
            return Promise.reject(new Error('Socket is not connected.'));
        }
    }

    getMyInfo(){
        return this.myInfo
    }

    getOrders({ state, symbol } = {}) {
      let view = this.myOrders;
      if (state)  view = view.filter(o => o.state === state);
      if (symbol) view = view.filter(o => o.symbol === symbol);
      return Object.freeze(view.map(o => ({ ...o }))); // read-only snapshot
    }

    // Fetch the orderbook data through socket
    getOrderbookData(filter) {
        return new Promise((resolve, reject) => {
            this.socket.emit('update-orderbook', filter);
            this.socket.once('orderbook-data', (data) => {
                resolve(data);
            });
            this.socket.once('order:error', (error) => {
                reject(error);
            });
        });
    }

    // Cancel an existing order through socket
    cancelOrder(orderUUID) {
        if (!this.socket) return Promise.reject(new Error('Socket not connected'));
        const id = (orderUUID && (orderUUID.orderUuid || orderUUID.uuid)) || orderUUID;
        const hit = this.myOrders.find(o => o.id === id || o.orderUuid === id || o.uuid === id || o?.details?.uuid === id);
        if (!hit) throw new Error(`Order ${id} not found`);
        const details = hit.details ?? hit;
        const props = details.props ?? details.order?.props ?? {};
        // derive marketKey (spot or futures)
        const f = props.id_for_sale ?? props.idForSale ?? props.first_token ?? props.firstToken;
        const d = props.id_desired  ?? props.idDesired  ?? props.second_token ?? props.secondToken;
        const cid = props.contract_id ?? props.contractId;
        const exp = props.expiry ?? props.maturity_block ?? 'perp';
        const marketKey = details.marketKey ?? details.order?.marketKey ??
            (cid ? `${cid}-${exp}` :
            (Number.isFinite(+f) && Number.isFinite(+d) ? ((+f < +d) ? `${+f}-${+d}` : `${+d}-${+f}`) : undefined));

        return new Promise((resolve, reject) => {
            this.socket.once('order:canceled', (ack) => {
            this.myOrders = this.myOrders.filter(o => o.id !== id && o.orderUuid !== id && o.uuid !== id);
            resolve(ack ?? { orderUUID: id });
            });
            this.socket.once('order:error', reject);
            this.socket.emit('close-order', { orderUUID: id, ...(props && { props }), ...(marketKey && { marketKey }) });
        });
        }

   // Modified getSpotMarkets with error handling for undefined response
   // Modified getSpotMarkets with safer logging
    async getSpotMarkets() {
            const response = await axios.get(`${this.apiUrl}/markets/spot/${this.network}`);
            
            // Log just the response data instead of the whole response
            console.log('Spot Markets Response Data:', util.inspect(response.data, { depth: null }));

           const payload = Array.isArray(response.data) ? response.data : response.data.data;
        const markets = payload?.[0]?.markets;
        if (markets){ return markets
        }else{throw new Error('Invalid response format: spot markets not found')};
    }

    // Modified getFuturesMarkets with safer logging
    async getFuturesMarkets() {
            const response = await axios.get(`${this.apiUrl}/markets/futures/${this.network}`);
            
            // Log just the response data instead of the whole response
            //console.log('Futures Markets Response Data:', util.inspect(response.data, { depth: null }));

           
           const payload = Array.isArray(response.data) ? response.data : response.data.data;
        const markets = payload?.[0]?.markets;
        if (markets){ return markets
        }else{throw new Error('Invalid response format: futures markets not found')};
    }

    async checkSync(){
        const track = await walletListener.getTrackHeight()
        const sync = await walletListener.checkSync()

        return {realTimeModeHeight: track, txIndexHeight: sync.txIndex, consensusParseHeight: sync.consensus}
    }
}

module.exports = ApiWrapper
// Example usage
/*const api = new ApiWrapper('http://172.81.181.19', 9191);

// Example: Sending a new order
const newOrder = {
    isLimitOrder: true,
    props: {
        id_desired: 1,
        id_for_sale: 2,
        amount: 100,
        price: 0.05
    },
    action: 'BUY'
};

api.sendOrder(newOrder)
    .then(orderUuid => {
        console.log(`Order saved with UUID: ${orderUuid}`);
    })
    .catch(error => {
        console.error(`Order failed: ${error}`);
    });

// Example: Fetching orderbook data
api.getOrderbookData({ first_token: 1, second_token: 2, type: 'SPOT' })
    .then(data => {
        console.log('Orderbook Data:', data);
    })
    .catch(error => {
        console.error('Failed to fetch orderbook data:', error);
    });

*/