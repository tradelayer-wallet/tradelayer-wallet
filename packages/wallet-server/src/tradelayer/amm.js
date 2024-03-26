const ContractRegistry = require('./contractRegistry.js')
const Orderbook = require('./orderbook.js')
const Clearing = require('./clearing.js')

class AMMPool {
    constructor(initialPosition, maxPosition, maxQuoteSize, contractType) {
        this.position = initialPosition;
        this.maxPosition = maxPosition;
        this.maxQuoteSize = maxQuoteSize;
        this.contractType = contractType;
        this.lpAddresses = {}; // Object to store LP addresses and their positions
        this.ammOrders = []; // Array to store AMM orders
    }

    static async updateOrdersForAllContractAMMs(block) {
        const ContractRegistry = require('./contractRegistry.js')
        // Get the list of all contract IDs
        const contractIds = await ContractRegistry.loadContractSeries();
        if (contractIds.size === 0||contractIds=== {}) {
          return; // No contracts found, return early
        }

        //console.log('displaying contract Ids object in update AMM orders ' +JSON.stringify(contractIds))
        // Loop through each contract ID
        for (const contractId of contractIds) {
            let change = await Clearing.isPriceUpdatedForBlockHeight(contractId, block)
            if(!change){continue}
            let blob = await Clearing.getPriceChange(blockHeight, contractId)
            let lastPrice = blob.lastPrice
            // Get the AMM instance for the current contract ID
            const ammInstance = await ContractRegistry.getAMMInstance(contractId);
            
            // Get the orderbook key for the current contract ID
            const orderBookKey = contractId; // Assuming the orderbook key is the same as the contract ID
            let inverse = ContractRegistry.isInverse(contractId)
            let priceDistance = 0.2
            let token = false
            // Generate orders for the AMM instance
            const orders = await ammInstance.generateOrders(lastPrice, priceDistance, totalOrders, contractId, null, inverse, token);

             let orderbook = Orderbook.getOrderbookInstance(orderBookKey)
                 orderbook.cancelOrdersByCriteria('amm', orderBookKey, {},false,true)

            // Insert the generated orders into the orderbook
            for (const order of orders) {
                // Determine if it's a buy or sell order based on order.side
                const isBuyOrder = order.side === 'buy';
                
                // Determine if it's a liquidation order based on order.isLiq
                const isLiq = order.isLiq;
               
                // Insert the order into the orderbook
                const message = await orderbook.insertOrder(order, orderBookKey, isBuyOrder, isLiq);
                console.log(message);
            }

            console.log(`Orders updated for contract ID ${contractId}`);
        }

        //console.log("Orders updated for all AMMs.");
    }


    async insertCapital(address, id, capital, isContract, id2, amount2, block) {
        // Check if the pool has reached its maximum position
        if (this.position + capital > this.maxPosition) {
            throw new Error('Pool has reached its maximum position');
        }
        // Add capital to the pool's position
        this.position += capital;
        
        // Store LP shares for the address
        this.lpShares[address] = (this.lpShares[address] || 0) + capital;

        // Credit LP tokens to the LP address using TallyMap
        let LPPropertyId;
        let LPPropertyId2
        if (isContract) {
            LPPropertyId = `${id}-LP`;
        } else {
            LPPropertyId = `${id}-${id2}-LP`;
            LPPropertyId2 = `${id2}-${id1}-LP`
        }
        await TallyMap.updateBalance(address, id, -capital, 0, 0, 0, 'AMMPledge', block);
        await TallyMap.updateBalance(address, LPPropertyId, capital, 0, 0, 0, 'LPIssue', block)
        if(!isContract){
            await TallyMap.updateBalance(address, id2, -amount2, 0, 0, 0, 'AMMPledge', block);
            await TallyMap.updateBalance(address, LPPropertyId2, amount2, 0, 0, 0, 'LPIssue', block)
        }
    }

    async redeemCapital(address, id, capital, isContract, id2, amount2,block) {
        // Check if the address has enough LP shares to redeem
        if (!this.lpShares[address] || this.lpShares[address] < capital) {
            throw new Error('Insufficient LP shares to redeem');
        }
        // Deduct capital from the pool's position
        this.position -= capital;
        
        // Remove redeemed capital from LP shares
        this.lpShares[address] -= capital;

        // Remove LP address if its LP shares become 0
        if (this.lpShares[address] === 0) {
            delete this.lpShares[address];
        }
        let collateralId
        if(isContract){
            collateralId = ContractRegistry.getCollateralId(id)
        }

        // Debit LP tokens from the LP address using TallyMap
        let LPPropertyId;
        let LPPropertyId2
        if (isContract) {
            LPPropertyId = `${this.contractId}-LP`;
        } else {
            LPPropertyId = `${id}-${id2}-LP`;
            LPPropertyId2 = `${id2}-${id}-LP`;
        }
        let adjustedRedemptionValue = this.calculateRedemptionValue(capital)
        let adjustedRedemptionValue2 
        if(!isContract){
            adjustedRedemptionValue2= this.calculateRedemptionValue(amount2)
        }
        await TallyMap.updateBalance(address, LPPropertyId, -capital, 0, 0, 0, 'redeemLP', block);
        if(isContract){
            await TallyMap.updateBalance(address, collateralId, adjustedRedemptionValue,0,0,0, 'returnedFromAMM', block)
        }else{
            await TallyMap.updateBalance(address,LPPropertyId2, adjustedRedemptionValue2,0,0,0,'returnedFromAMM',block)
        }
            
    }

    calculateRedemptionValue(amount, isContract, poolData, lastPrice) {
        if (isContract) {
            // If the AMM is for a contract
            // Calculate the pro-rated value based on the total value of collateralId tokens in the pool
            const totalCollateralValue = poolData.collateralId * poolData.price;
            const poolValue = poolData.tokens + totalCollateralValue;
            const redemptionValue = (amount / poolData.tokens) * poolValue;
            return redemptionValue;
        } else {
            // If the AMM is for tokens
            // Calculate the redemption value based on the last price
            const redemptionValue = amount * lastPrice;
            return redemptionValue;
        }
    }


    // Function to calculate the total position of an address in the pool
    calculateTotalPosition(address = null) {
        if (address === null) {
            // Calculate the total position of all LPs in the pool
            const totalShares = Object.values(this.lpShares).reduce((total, shares) => total + shares, 0);
            return (totalShares / this.maxPosition) * 100; // Calculate percentage
        } else {
            // Calculate the pro-rata position of the given address
            if (this.lpShares[address]) {
                return (this.lpShares[address] / this.maxPosition) * 100; // Calculate percentage
            } else {
                return 0; // If the address is not found in the LP shares, return 0
            }
        }
    }

    // Function to look up which addresses are LPs for a given contractid's AMM
    getLPAddresses() {
        return Object.keys(this.lpAddresses);
    }

    // Function to get AMM orders and positions
    getAMMOrdersAndPositions() {
        // You can return any relevant data here, such as orders and positions
        return {
            orders: this.ammOrders,
            position: this.position,
            maxPosition: this.maxPosition,
            lpAddresses: this.lpAddresses
        };
    }


    calculateOrderSize(distanceFromOracle, priceDistance, totalOrders) {
        // Calculate order size based on the given distance from the oracle
        const totalDistance = 0.2 * priceDistance; // Total distance from bottom tick to top of the book
        const distanceRatio = distanceFromOracle / totalDistance;
        let orderSize;

        if (distanceRatio <= 0.05) {
            // Bottom quarter of the book
            orderSize = totalOrders * 0.35;
        } else if (distanceRatio <= 0.1) {
            // Second to bottom quarter of the book
            orderSize = totalOrders * 0.25;
        } else if (distanceRatio <= 0.15) {
            // Third to bottom quarter of the book
            orderSize = totalOrders * 0.15;
        } else {
            // Top quarter of the book
            orderSize = totalOrders * 0.05;
        }

        return orderSize;
    }

    generateOrdersForInverse(oraclePrice, priceDistance, totalOrders) {
        // Calculate distance from oracle to bottom tick
        const distanceFromOracle = 0.001; // Assuming bottom tick is 0.01 away from oracle

        // Calculate order size based on distance from oracle
        const orderSize = this.calculateOrderSize(distanceFromOracle, priceDistance, totalOrders);

        // Adjust quote size based on position and max quote size
        let quoteSize = Math.min(this.position, this.maxQuoteSize);

        // Adjust order size based on available quote size
        const maxOrderSize = Math.min(orderSize, quoteSize);

        // Update position and quote size
        this.position += maxOrderSize;
        quoteSize -= maxOrderSize;

        // Generate order object
        const order = {
            price: oraclePrice + distanceFromOracle, // Assume bottom tick is above oracle price
            size: maxOrderSize,
            side: 'sell' // Assuming it's a sell order for inverse quoted contracts
        };

        return order;
    }

    generateOrdersForLinear(oraclePrice, priceDistance, totalOrders) {
        // Calculate distance from oracle to bottom tick
        const distanceFromOracle = 0.01; // Assuming bottom tick is 0.01 away from oracle

        // Calculate order size based on distance from oracle
        const orderSize = this.calculateOrderSize(distanceFromOracle, priceDistance, totalOrders);

        // Adjust quote size based on position and max quote size
        let quoteSize = Math.min(this.position, this.maxQuoteSize);

        // Adjust order size based on available quote size
        const maxOrderSize = Math.min(orderSize, quoteSize);

        // Update position and quote size
        this.position += maxOrderSize;
        quoteSize -= maxOrderSize;

        // Generate order object
        const order = {
            price: oraclePrice + distanceFromOracle, // Assume bottom tick is above oracle price
            size: maxOrderSize,
            side: this.position > 0 ? 'buy' : 'sell' // Buy if long, sell if short for linear contracts
        };

        return order;
    }

    async generateTokenOrders(tokenXId, tokenYId, totalLiquidity, totalOrders, lastPrice, blockHeight) {
        const pairKey = `${tokenXId}-${tokenYId}`;
        const orderbook = await Orderbook.getOrderbookInstance(pairKey);

        const curveDistance = 0.30 * lastPrice; // Distance from the last price
        const orderIncrement = curveDistance / totalOrders; // Increment for each order

        // Calculate the initial supply ratio
        const initialXSupply = Math.sqrt(totalLiquidity * (1 - curveDistance / (2 * lastPrice)));
        const initialYSupply = Math.sqrt(totalLiquidity * (1 + curveDistance / (2 * lastPrice)));

        // Generate orders for token X and token Y
        for (let i = 1; i <= totalOrders; i++) {
            const priceX = lastPrice - (i * orderIncrement);
            const priceY = lastPrice + (i * orderIncrement);

            // Calculate the supply at this price level
            const xSupply = initialXSupply * (lastPrice / priceX);
            const ySupply = totalLiquidity / xSupply;

            const orderX = {
                offeredPropertyId: tokenXId,
                desiredPropertyId: tokenYId,
                amountOffered: xSupply - initialXSupply,
                amountExpected: ySupply - initialYSupply,
                price: priceX,
                sender: "pool",
                txid: "amm"
            };

            const orderY = {
                offeredPropertyId: tokenYId,
                desiredPropertyId: tokenXId,
                amountOffered: ySupply - initialYSupply,
                amountExpected: xSupply - initialXSupply,
                price: priceY,
                sender: "pool",
                txid: "amm"
            };

            try {
                await Promise.all([
                    orderbook.addTokenOrder(orderX, blockHeight, txid),
                    orderbook.addTokenOrder(orderY, blockHeight, txid)
                ]);
            } catch (error) {
                console.error(`Error placing orders for pair ${pairKey}: ${error.message}`);
                // Handle the error as needed
            }
        }

        console.log(`Token orders placed for pair ${pairKey}`);
    }

    generateOrders(lastPrice, priceDistance, totalOrders, id1, id2, inverse, token) {
        
        if(token==true){
            let totalLiquidity = this.calculateTotalLiquidityForToken(id1,id2,totalLiquidity,lastPrice,block);
            return this.generateTokenOrders()
        }

        if (this.contractType === 'inverse') {
            return this.generateOrdersForInverse(lastPrice, priceDistance, totalOrders);
        } else if (this.contractType === 'linear') {
            return this.generateOrdersForLinear(lastPrice, priceDistance, totalOrders);
        } else {
            throw new Error('Invalid contract type');
        }
    }

}

module.exports = AMMPool