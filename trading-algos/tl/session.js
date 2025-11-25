class OrderbookSession {
    constructor(socket, myInfo, txsService, client) {
        this.socket = socket;
        this.myInfo = myInfo;
        this.txsService = txsService;
        this.client = client;
        this.handleOrderMatches();
    }

    handleOrderMatches() {
        this.socket.on('orderMatched', (matchData) => {
            // Assume matchData contains buyer, seller, tradeInfo, type of trade, etc.
            const { buyerInfo, sellerInfo, tradeInfo, typeTrade } = matchData;

            // Check if we are the buyer or seller
            if (this.myInfo.address === buyerInfo.address) {
                this.initiateBuySwap(typeTrade, tradeInfo, buyerInfo, sellerInfo);
            } else if (this.myInfo.address === sellerInfo.address) {
                this.initiateSellSwap(typeTrade, tradeInfo, buyerInfo, sellerInfo);
            }
        });
    }

    initiateBuySwap(typeTrade, tradeInfo, buyerInfo, sellerInfo) {
        const buySwapper = new BuySwapper(typeTrade, tradeInfo, buyerInfo, sellerInfo, this.client, this.socket, this.txsService);
        buySwapper.onReady().then((res) => {
            if (res.error) {
                console.error(`Buy Swap Failed: ${res.error}`);
            } else {
                console.log(`Buy Swap Complete: ${res.data}`);
            }
        });
    }

    initiateSellSwap(typeTrade, tradeInfo, buyerInfo, sellerInfo) {
        const sellSwapper = new SellSwapper(typeTrade, tradeInfo, sellerInfo, buyerInfo, this.client, this.socket, this.txsService);
        sellSwapper.onReady().then((res) => {
            if (res.error) {
                console.error(`Sell Swap Failed: ${res.error}`);
            } else {
                console.log(`Sell Swap Complete: ${res.data}`);
            }
        });
    }
}
