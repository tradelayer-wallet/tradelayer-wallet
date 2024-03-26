const TallyMap = require('./tally.js')
const ContractRegistry = require('./contractRegistry.js');
const db = require('./db.js')
const BigNumber = require('bignumber.js');
// Access the database where oracle data is stored
const oracleDataDB = db.getDatabase('oracleData');
const MarginMap = require('./marginMap.js')
const Insurance = require('./insurance.js')
const Orderbooks = require('./orderbook.js')
const Channels = require('./channels.js')
const PropertyManager = require('./property.js')
//const VolumeIndex = require('./volumeIndex.js')


class Clearing {
    // ... other methods ...
    constructor() {
        // Access the singleton instance of TallyMap
        //this.tallyMap = TallyMap.getSingletonInstance();
        this.balanceChanges = []; // Initialize an array to track balance changes

    }

    static async clearingFunction(blockHeight) {
        //console.log(`Starting clearing operations for block ${blockHeight}`);

        // 1. Fee Cache Buy
        await this.feeCacheBuy(blockHeight);

        // 2. Set channels as closed if needed
        await Channels.removeEmptyChannels(blockHeight);

        // 3. Settle trades at block level
        await this.makeSettlement(blockHeight);

        //console.log(`Clearing operations completed for block ${blockHeight}`);
        return
    }

    // Define each of the above methods with corresponding logic based on the C++ functions provided
    // ...

    static async feeCacheBuy(block) {
        //console.log('Processing fee cache buy');

        // Fetch fees from your data source (e.g., database or in-memory store)
        let fees = await TallyMap.loadFeeCacheFromDB();
        //console.log('fee cache size '+fees.size)
            // If the fees array is empty, return early
            if (fees.size === 0) {

                //console.log('Fee cache is empty');
                return;
            }else{ 
                 /*   console.log('Checking fee cache:');
                // Iterate over the map entries
                for (let [id, feeAmount] of fees.entries()) {
                    console.log('ID:' +JSON.stringify(id)+' Fee Amount:'+feeAmount);
                }*/
            }
       // Process each fee category
        for (let fee of fees) {
            //console.log('fee'+JSON.stringify(fee))
             let propertyData = null;
             let threshold = 1;
            if(fee[0]==null){continue}else{
                propertyData = await PropertyManager.getPropertyData(fee[0].id);
                //console.log('propertyData' + Boolean(propertyData !== null)+JSON.stringify(propertyData))
                
            }
            
            if(propertyData !== null) {
                if (propertyData.totalInCirculation > 10000000000) {
                    threshold = new BigNumber(1).times(new BigNumber(10000000000).dividedBy(propertyData.totalInCirculation)).toNumber();
                }

                if (fee[1] >= threshold) {
                    console.log('above fee threshold '+fee[1]+' '+fee[0].id)
                    let orderBookKey = '1-' + fee[0].id;
                    let orderbook = await Orderbooks.getOrderbookInstance(orderBookKey);
                    const order = {
                        offeredPropertyId: fee[0].id,
                        desiredPropertyId: 1,
                        amountOffered: fee[1],
                        amountExpected: 0.00000001,
                        blockTime: block,
                        sender: 'feeCache'
                    };
            
                    const calculatedPrice = orderbook.calculatePrice(order.amountOffered, order.amountExpected);
            
                    order.price = calculatedPrice;

                    let reply = await orderbook.insertOrder(order, orderBookKey, false,false);
                    console.log(reply)
                    await TallyMap.updateFeeCache(fee[0].id, -fee.value);
                    const matchResult = await orderbook.matchTokenOrders(orderBookKey);
                    if (matchResult.matches && matchResult.matches.length > 0) {
                        console.log('Fee Match Result:', matchResult);
                        await orderbook.processTokenMatches(matchResult.matches, blockHeight, null, false);
                    } else {
                        console.log('No Matches for fee' +JSON.stringify(order));
                    }
                    await orderbook.saveOrderBook(orderBookKey);
                }
             }else{
                  // Handle the case where propertyData is null
                console.log(`Property data for fee id ${fee[0].id} is null.`);
             }
        }

        // Save any changes back to your data source
        //await TallyMap.saveFeeCacheToDB();
    }

   static async updateLastExchangeBlock(blockHeight) {
        console.log('Updating last exchange block in channels');

        // Fetch the list of active channels
        let channels = await this.getActiveChannels();

        // Update the last active block for each channel
        channels.forEach(channel => {
            if (channel.isActive) {
                channel.lastExchangeBlock = blockHeight;
            }
        });

        // Save the updated channel information
        await this.saveChannels(channels);
    }


    static async fetchLiquidationVolume(contractId, blockHeight) {
        // Assuming you have a database method to fetch liquidation data
        try {
            const liquidationData = await db.getDatabase('clearing').findOneAsync({ _id: `liquidation-${contractId}-${blockHeight}` });
            return liquidationData ? liquidationData.volume : null; // Assuming 'volume' is the field you're interested in
        } catch (error) {
            if (error.name === 'NotFoundError') {
                console.log(`No liquidation data found for contract ID ${contractId} at block ${blockHeight}`);
                return null; // Handle case where data is not found
            }
            throw error; // Rethrow other types of errors
        }
    }

        /**
     * Loads clearing deltas from the clearing database for a given block height.
     * @param {number} blockHeight - The block height for which to load clearing deltas.
     * @returns {Promise<Array>} - A promise that resolves to an array of clearing deltas for the block.
     */
    static async loadClearingDeltasForBlock(blockHeight) {
        try {
            const clearingDeltas = [];
            const query = { blockHeight: blockHeight }; // Query to match the block height

            // Fetch the deltas from the database
            const results = await db.getDatabase('clearing').findAsync(query);
            results.forEach(doc => {
                clearingDeltas.push(doc.value); // Assuming each document has a 'value' field with the delta data
            });

            return clearingDeltas;
        } catch (error) {
            console.error('Error loading clearing deltas:', error);
            throw error;
        }
    }

    static async isPriceUpdatedForBlockHeight(contractId, blockHeight) {
        // Determine if the contract is an oracle contract
        const ContractRegistry = require('./contractRegistry.js')
        const isOracle = await ContractRegistry.isOracleContract(contractId);
        let latestData;
        //console.log('checking if contract is oracle '+contractId +' '+isOracle)
        if (isOracle) {
            let oracleId = await ContractRegistry.getOracleId(contractId)
            // Query the database for the latest oracle data for the given contract
            //console.log('oracle id '+oracleId)         
            const latestData = await oracleDataDB.findAsync({ oracleId: oracleId });
            //console.log('is price updated ' +JSON.stringify(latestData))
            if (latestData.length>0) {
                const sortedData = [latestData].sort((a, b) => b.blockHeight - a.blockHeight);
                const latestBlockData = sortedData[sortedData.length-1];
                const lastPriceEntry = latestBlockData[latestBlockData.length-1]
                //console.log('checking data '+sortedData+ ' ok now latest Block data '+latestBlockData+' last price entry '+lastPriceEntry)
                // Now, latestBlockData contains the document with the highest blockHeight
                if(lastPriceEntry.blockHeight==blockHeight){
                    console.log('latest data '+lastPriceEntry.blockHeight + ' blockHeight '+blockHeight + ' latestData exists and its block = current block ' +Boolean(lastPriceEntry && lastPriceEntry.blockHeight == blockHeight) )
                    return true
                }
            } else {
                //console.error('No data found for contractId:', contractId);
            }
        } /*else {
            // Access the database where volume index data is stored
            const volumeIndexDB = db.getDatabase('volumeIndex');
                        // Query the database for the latest volume index data for the given contract
            const latestData = await volumeIndexDB.findOneAsync({ contractId: contractId });
            if (latestData) {
                const sortedData = [latestData].sort((a, b) => b.blockHeight - a.blockHeight);
                const latestBlockData = sortedData[0];
                // Now, latestBlockData contains the document with the highest blockHeight
                if(latestData.blockHeight==blockHeight){

                console.log('Latest Block Data:', latestBlockData);
                    //console.log('latest data '+latestData.blockHeight + ' blockHeight '+blockHeight + ' latestData exists and its block = current block ' +Boolean(latestData && latestData.blockHeight == blockHeight) )
                    return true
                }
            } else {
                //console.error('No data found for contractId:', contractId);
            }
        }*/
        //console.log('no new data')
        return false; // No updated data for this block height
    }

    static async makeSettlement(blockHeight) {
            const ContractRegistry = require('./contractRegistry.js');
            const contracts = await ContractRegistry.loadContractSeries();
        for (const contract of contracts) {
            // Check if there is updated price information for the contract
            if (await Clearing.isPriceUpdatedForBlockHeight(contract.id, blockHeight)) {
                console.log('new price')
                // Proceed with processing for this contract
                console.log('Making settlement for positions at block height:', JSON.stringify(contract) + ' ' + blockHeight);
                let collateralId = await ContractRegistry.getCollateralId(contract.id)
                let inverse = await ContractRegistry.isInverse(contract.id)
                const notionalValue = await ContractRegistry.getNotionalValue(contract.id)
                
                // Update margin maps based on mark prices and current contract positions
                let {positions, isLiq} = await Clearing.updateMarginMaps(blockHeight, contract.id, collateralId, inverse,notionalValue); //problem child

                 // Perform additional tasks like loss socialization if needed
                if(isLiq){
                    await Clearing.performAdditionalSettlementTasks(blockHeight,positions,contract.id,positions.lastMark);
                }
            } else {
                // Skip processing for this contract
                //console.log(`No updated price for contract ${contract.id} at block height ${blockHeight}`);
                continue;
            }
        }
        return
    }

    
    static async updateMarginMaps(blockHeight, contractId, collateralId, inverse, notionalValue) {
        let liquidationData = [];
        // Load margin map for the specific contract series
            let marginMap = await MarginMap.getInstance(contractId);
             // Fetch positions that need adjustment
                let positions = await marginMap.getAllPositions();
                //console.log('positions in clearing' +JSON.stringify(positions))
                // Iterate through each position to adjust for profit or loss
                let blob = await Clearing.getPriceChange(blockHeight, contractId)
                console.log('clearing price difference '+blob.lastPrice +' '+ blob.thisPrice)
                let isLiq =false
        for (let position of positions) {
            if(blob.lastPrice==null){
                    console.log('last price was null what about avg price? '+position.avgPrice)
                    blob.lastPrice= position.avgPrice
                }
            // Update margin based on PnL change
            let pnlChange = await Clearing.calculatePnLChange(position, blob.thisPrice, blob.lastPrice, inverse,notionalValue);
            console.log('updatingMarginMaps with pnlChange '+JSON.stringify(position) + ' '+ pnlChange)
            const newPosition = await marginMap.clear(position, position.address, pnlChange, position.avgPrice,contractId)
            console.log('new Position '+ JSON.stringify(newPosition))
            
            if(pnlChange<0){
                let balance = await TallyMap.hasSufficientBalance(position.address, collateralId, Math.abs(pnlChange))
                console.log('displaying return from has Suf. Balance in update Margin Maps' +JSON.stringify(balance))
                if(balance.hasSufficient==true){
                        await TallyMap.updateBalance(position.address, collateralId, pnlChange, 0, 0,0,'clearing', blockHeight);
                }else{
                    let tally = await TallyMap.getTally(position.address, collateralId)
                    let totalCollateral = tally.available+tally.margin
                    await TallyMap.updateBalance(position.address, collateralId, -tally.available, 0, 0,0,'clearingLoss', blockHeight);
                    console.log('fully utilized available margin for '+JSON.stringify(newPosition))
                    if(totalCollateral>Math.abs(pnlChange)){
                        let marginDent = Math.abs(pnlChange)-tally.available
                        await TallyMap.updateBalance(position.address, collateralId, 0, 0, -marginDent,0,'clearingLoss', blockHeight);
                        await marginMap.updateMargin()    
                        if (await marginMap.checkMarginMaintainance(position.address,contractId)){
                            isLiq=true
                        }
                    }else{
                        isLiq=true
                    }
                   
                    if(isLiq==true){
                         let liq = await marginMap.triggerLiquidations(newPosition, blockHeight,contractId);
                         console.log('liquidation!: '+JSON.stringify(liq))
                         if(liq!="err:0 contracts"){
                              const orderbook = await Orderbooks.getOrderbookInstance(contractId)
                             orderbook.addContractOrder(contractId, liq.price,liq.size,liq.side, false,blockHeight,'liq',position.address,true)
                         }else{
                            throw new Error(console.log(liq))
                         }
                    }
                }
            }else{
                  await TallyMap.updateBalance(position.address, collateralId, pnlChange, 0, 0,0,'clearing',blockHeight);
            }              
        }
        positions.lastMark = blob.lastPrice
            // Save the updated margin map
        await marginMap.saveMarginMap(false);
        return {positions, isLiq};
    }

    static async getPriceChange(blockHeight, contractId){
        let isOracleContract = await ContractRegistry.isOracleContract(contractId)
        let oracleId = null
        let propertyId1 = null
        let propertyId2 = null
        let latestData
        if(isOracleContract){
            oracleId = await ContractRegistry.getOracleId(contractId)
            latestData = await oracleDataDB.findAsync({ oracleId: oracleId });
            //console.log('inside oracle getPriceChange ' +JSON.stringify(latestData))
        }else{
            let info = await ContractRegistry.getContractInfo(contractId)
            propertyId1 = info.native.native.onChainData[0]
            propertyId2 = info.native.native.onChainData[1]
            latestData = await volumeIndexDB.findOneAsync({propertyId1:propertyId1,propertyId2:propertyId2})
        }
            //console.log('is price updated ' +JSON.stringify(latestData))
                const sortedData = [latestData].sort((a, b) => b.blockHeight - a.blockHeight);
                const latestBlockData = sortedData[sortedData.length-1];
                const lastPriceEntry = latestBlockData[latestBlockData.length-1]
                const currentMarkPrice = lastPriceEntry.data.price;
                let previousMarkPrice = null
                
                if(latestData.length>1){
                    previousMarkPrice = latestBlockData[latestBlockData.length-2].data.price
                }
                    console.log('checking mark price current and last '+currentMarkPrice+' '+previousMarkPrice)
                return {lastPrice: previousMarkPrice, thisPrice:currentMarkPrice}
    }

    static async calculatePnLChange(position, currentMarkPrice, previousMarkPrice, inverse,notionalValue){
      

        // Calculate P&L change for the position based on the number of contracts
        // Assuming a long position benefits from a price increase and vice versa
        let pnl 

        const priceBN = new BigNumber(currentMarkPrice);
        const avgPriceBN = new BigNumber(previousMarkPrice);
        const contractsBN = new BigNumber(position.contracts);
        const notionalValueBN = new BigNumber(notionalValue);

        if (inverse) {
            // For inverse contracts: PnL = (1/entryPrice - 1/exitPrice) * contracts * notional
            pnl = priceBN
                .minus(1)
                .dividedBy(avgPriceBN.minus(1))
                .times(contractsBN)
                .times(notionalValueBN);

            //console.log('pnl ' + pnl.toNumber());
        } else {
            // For linear contracts: PnL = (exitPrice - entryPrice) * contracts * notional
            pnl = priceBN
                .minus(avgPriceBN)
                .times(contractsBN)
                .times(notionalValueBN);

            //console.log('pnl ' + pnl.toNumber());
        }

        console.log('clearing PNL ' +priceBN +' '+currentMarkPrice+' '+avgPriceBN+' ' +previousMarkPrice+' '+contractsBN+' '+position.contracts+' '+notionalValueBN+' '+notionalValue)
        // Adjust sign based on whether the position is long or short
        if(contractsBN<0){
            pnl.times(-1)
        }
        //pnl = position.contracts>0 ? pnl : pnl.negated();
        console.log('pnl '+pnl.toNumber())
        return pnl.toNumber();
    }

    static async getBalance(holderAddress) {
        // Replace this with actual data fetching logic for your system
        try {
            let balance = await database.getBalance(holderAddress);
            return balance;
        } catch (error) {
            console.error('Error fetching balance for address:', holderAddress, error);
            throw error;
        }
    }

    static async performAdditionalSettlementTasks(blockHeight,positions, contractId, mark) {
 
        try {
            // Step 1: Calculate total losses
            const totalLoss = Clearing.getTotalLoss(positions,contractId,mark);

            // Step 2: Check if insurance fund payout is needed
            if (totalLoss > 0) {
                // Step 3: Apply insurance fund payout
                const insurance = await Insurance.getFund(contractId)
                const payout = insurance.calcPayout(totalLoss);
                //insert function to pro-rate payout to all positions
                //const map = await MarginMap.getInstance(contractId)
                //map.applyInsurancePayout(payout,blockHeight)
                // Step 4: Socialize remaining loss if any
                const remainingLoss = totalLoss - payout;
                if (remainingLoss > 0) {
                    await Clearing.socializeLoss(remainingLoss, positions);
                }
            }
        } catch (error) {
            console.error('Error performing additional settlement tasks:', error);
            throw error;
        }
    }


    static async auditSettlementTasks(blockHeight, positions) {
        try {
            // Check total margin consistency
            let totalMargin = this.calculateTotalMargin(positions);
            if (!this.isMarginConsistent(totalMargin)) {
                throw new Error("Inconsistent total margin detected");
            }

            // Verify insurance fund balance is not negative
            if (this.insuranceFund.getBalance() < 0) {
                throw new Error("Negative balance in the insurance fund");
            }

            // Save index populated during balance adjustment
            await this.saveAuditIndex(blockHeight);
        } catch (error) {
            console.error('Audit error at block height', blockHeight, ':', error);

                 // Check for the consistency of balance updates
            let balanceUpdates = this.fetchBalanceUpdatesForSettlement();
                if (!this.areBalanceUpdatesConsistent(balanceUpdates)) {
                    throw new Error("Inconsistent balance updates detected");
                }

                    // Save audit data
                    const auditData = this.prepareAuditData(); 
                    await this.saveAuditData(blockHeight, auditData);
        }
    }

    static async saveClearingSettlementEvent(contractId, settlementDetails, blockHeight) {
        const clearingDB = dbInstance.getDatabase('clearing');
        const recordKey = `clearing-${contractId}-${blockHeight}`;

        const clearingRecord = {
            _id: recordKey,
            contractId,
            settlementDetails,
            blockHeight
        };

        try {
            await clearingDB.updateAsync(
                { _id: recordKey },
                clearingRecord,
                { upsert: true }
            );
            console.log(`Clearing settlement event record saved successfully: ${recordKey}`);
        } catch (error) {
            console.error(`Error saving clearing settlement event record: ${recordKey}`, error);
            throw error;
        }
    }

    static async loadClearingSettlementEvents(contractId, startBlockHeight = 0, endBlockHeight = Number.MAX_SAFE_INTEGER) {
        const clearingDB = dbInstance.getDatabase('clearing');
        try {
            const query = {
                contractId: contractId,
                blockHeight: { $gte: startBlockHeight, $lte: endBlockHeight }
            };
            const clearingRecords = await clearingDB.findAsync(query);
            return clearingRecords.map(record => ({
                blockHeight: record.blockHeight,
                settlementDetails: record.settlementDetails
            }));
        } catch (error) {
            console.error(`Error loading clearing settlement events for contractId ${contractId}:`, error);
            throw error;
        }
    }

    static async getBalance(holderAddress) {
        // Replace this with actual data fetching logic for your system
        try {
            let balance = await database.getBalance(holderAddress);
            return balance;
        } catch (error) {
            console.error('Error fetching balance for address:', holderAddress, error);
            throw error;
        }
    }


    // Implement or reference these helper methods as per your system's logic
    static calculateTotalMargin(positions) {
        let totalMargin = 0;
        positions.forEach(position => {
            totalMargin += position.margin;  // Assuming each position object has a 'margin' property
        });
        return totalMargin;
    }

    static isMarginConsistent(totalMargin) {
        const expectedMargin = this.getExpectedTotalMargin(); // Implement this method based on your system
        // You can also implement a range-based check instead of an exact value match
        return totalMargin === expectedMargin;
    }

    static async saveAuditIndex(blockHeight) {
        const auditData = this.prepareAuditData(); // Implement this method to prepare data for saving
        try {
            await database.saveAuditData(blockHeight, auditData);
        } catch (error) {
            console.error('Error saving audit index for block height:', blockHeight, error);
            throw error;
        }
    }

    static prepareAuditData(blockHeight, positions, balanceChanges) {
        // The data structure to hold the audit data
        let auditData = {};

        balanceUpdates.forEach(update => {
            // Assuming each update has contractId, blockHeight, and other relevant info
            const key = `contract-${update.contractId}-block-${update.blockHeight}`;

            // Initialize sub-object if not already present
            if (!auditData[key]) {
                auditData[key] = [];
            }

            // Add the update to the appropriate key
            auditData[key].push({
                holderAddress: update.holderAddress,
                newBalance: update.newBalance,
                // Include any other relevant fields from the update
            });
        });
        // Reset the balanceChanges array after the audit process
        this.balanceChanges = [];

        return JSON.stringify(auditData);
    }

    static async getTotalLoss(positions, contractId) {
            let vwap = 0;
            let volume = 0;
            let bankruptcyVWAP = 0;
            let oracleTwap = 0;

            let isOracleContract = await ContractRegistry.isOracleContract(contractId);
            let notionalSize = await ContractRegistry.getNotionalValue(contractId)
            let marginMap = await MarginMap.getInstance(contractId)
            if (isOracleContract) {
                let liquidationData = await marginMap.fetchLiquidationVolume(positions, contractId);
                if (!liquidationData) {
                    console.log('No liquidation volume data found for oracle-based contract.');
                    return 0;
                }
                ({ volume, vwap, bankruptcyVWAP } = liquidationData);

                // Fetch TWAP data from oracle
                oracleTwap = await Oracles.getTwap(contractId); // Assuming Oracles module provides TWAP data
            } /*else{
                // Fetch VWAP data for native contracts
                let vwapData = VolumeIndex.getVwapData(contractId); // Assuming VolumeIndex module provides VWAP data
                if (!vwapData) {
                    console.log('No VWAP data found for native contract.');
                    return 0;
                }
                ({ volume, vwap, bankruptcyVWAP } = vwapData);
                oracleTwap = vwap;
            }*/

            return ((bankruptcyVWAP * notionalSize) * (volume * vwap * oracleTwap));
    }

    static async socializeLoss(contractId, totalLoss, positions, lastPrice) {
        try {
            // Get all open positions for the given contract
            const openPositions = await this.getAllPositions();

            // Calculate the volume weighted price for every open position
            const vwaps = await Promise.all(openPositions.map(async (position) => {
                // Get the market price for the contract (assuming you have a method to retrieve it)
                const marketPrice = await this.getMarketPrice(contractId);

                // Calculate the volume weighted price for the position
                const vwap = (position.avgPrice * position.contracts + lastPrice * position.unrealizedPNL) / (position.contracts + position.unrealizedPNL);

                return vwap;
            }));

            // Calculate the total volume weighted price and total open position uPNL
            const totalVWAP = vwaps.reduce((sum, vwap) => sum.plus(vwap), new BigNumber(0));
            const totalOpenUPNL = openPositions.reduce((sum, position) => sum.plus(position.unrealizedPNL), new BigNumber(0));

            // Calculate the percentage of total loss compared to total PNL
            const lossPercentage = totalLoss.dividedBy(totalOpenUPNL);

            // Reduce positive uPNL for all open positions by the calculated percentage
            const updatedPositions = openPositions.map((position, index) => {
                const vwap = new BigNumber(vwaps[index]);
                const adjustedUPNL = vwap.times(lossPercentage).times(position.contracts);

                // Ensure the adjusted uPNL doesn't exceed the total open position uPNL
                const newUPNL = BigNumber.minimum(adjustedUPNL, position.unrealizedPNL);

                // Update the position with the adjusted uPNL
                return {
                    ...position,
                    unrealizedPNL: newUPNL.toNumber(),
                };
            });

            // Update the positions in the margin map
            for (const updatedPosition of updatedPositions) {
                this.margins.set(updatedPosition.address, updatedPosition);
                await this.recordMarginMapDelta(updatedPosition.address, contractId, 0, 0, 0, -updatedPosition.unrealizedPNL, 0, 'socializeLoss');
            }

            // Save the updated margin map
            await this.saveMarginMap(true);

            console.log('Socialized loss successfully.');

        } catch (error) {
            console.error('Error socializing loss:', error);
            throw error;
        }
    }


    static async fetchAuditData(auditDataKey) {
        // Implement logic to fetch audit data from the database
        try {
            const auditData = await database.getAuditData(auditDataKey);
            return auditData;
        } catch (error) {
            console.error('Error fetching audit data:', error);
            throw error;
        }
    }

    // Additional helper methods or logic as required
}

module.exports = Clearing;