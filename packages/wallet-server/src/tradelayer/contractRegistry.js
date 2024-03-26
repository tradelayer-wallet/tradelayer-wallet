const db = require('./db')
const path = require('path');
const util = require('util');
//const TxUtils = require('./txUtils.js')
const TxIndex = require('./txIndex.js')
const BigNumber = require('bignumber.js')
const AMMPool = require('./AMM.js')

class ContractRegistry {
    constructor() {
        // ... Other initializations ...
        this.contractList = new Map()
        this.oracleList = new Map(); // Initialize if needed
        this.nativeList = new Map(); // Initialize if needed
   
    }

    static async loadContractSeries() {
        //console.log('loading contract list for this instance '+JSON.stringify(instance))
        const instance = ContractRegistry.getInstance(); // Access singleton instance
        //console.log('loading contract list for this instance '+JSON.stringify(instance))
        try {
            const docs = await db.getDatabase('contractList').findAsync({ type: 'contractSeries' });
            return instance.contractSeries = new Map(docs.map(doc => [doc.id, doc.data]));
        } catch (error) {
            console.error('Error loading contract series data:', error);
        }
    }

     // Singleton instance getter
    static getInstance() {
        if (!this.instance) {
            console.log('no instance detected creating new contract List obj')
            this.instance = new ContractRegistry();
        }
        return this.instance;
    }

    static async createContractSeries(native, underlyingOracleId, onChainData, notionalPropertyId, notionalValue, collateralPropertyId, leverage, expiryPeriod, series, inverse, fee, block, txid) {
        // Load the current contract list from the database
        const contractListDB = db.getDatabase('contractList');
        const currentContractList = await contractListDB.findAsync({ type: 'contractSeries' });
        const contractList = new Map(currentContractList.map(doc => [doc.id, doc.data]));

        // Generate a unique ID for the new contract series
        const seriesId = await ContractRegistry.getNextIdFromMap(contractList);
        const thisAMM = new AMMPool(0,1,10,seriesId)
        // Create the contract series object
        const contractSeries = {
            id: seriesId,
            native: native,
            underlyingOracleId: underlyingOracleId,
            onChainData: onChainData,
            notionalPropertyId: notionalPropertyId,
            notionalValue: notionalValue,
            collateralPropertyId: collateralPropertyId,
            leverage: leverage,
            expiryPeriod: expiryPeriod,
            series: series,
            inverse: inverse,
            fee: fee,
            contracts: {
                expired: [],
                unexpired: await ContractRegistry.generateContracts(expiryPeriod, series, seriesId, block)
            },
            ammPool: thisAMM // Add the AMM object to the contract series
        };

        // Add the new contract series to the contract list
        contractList.set(seriesId, contractSeries);

        // Save the updated contract list back to the database
        await ContractRegistry.saveDataToDb(contractList, 'contractSeries');

        console.log(`New contract series created: ID ${seriesId}`);
        return seriesId; // Return the new series ID
    }

    static async getAMM(contractId) {
        const contractInfo = await this.getContractInfo(contractId);
        if (contractInfo && contractInfo.amm) {
            // Assuming the AMM object is stored inside the contractInfo object
            return contractInfo.amm;
        } else {
            throw new Error(`AMM object not found for contract ID ${contractId}`);
        }
    }

    // Function to update AMM object when LPs pledge or redeem
    static async updateAMM(contractId, lpAddress, pledgeAmount, redeemAmount) {
        if (!this.contractList.has(contractId)) {
            throw new Error(`Contract ID ${contractId} not found in contract registry`);
        }
        
        const { ammPool } = this.contractList.get(contractId);
        
        // Update the AMM object based on LPs pledge or redeem
        if (pledgeAmount !== null && pledgeAmount > 0) {
            // Pledge scenario: Add liquidity
            ammPool.insertCapital(lpAddress, pledgeAmount);
        } else if (redeemAmount !== null && redeemAmount > 0) {
            // Redeem scenario: Remove liquidity
            ammPool.redeemCapital(lpAddress, redeemAmount);
        } else {
            throw new Error(`Invalid pledgeAmount (${pledgeAmount}) or redeemAmount (${redeemAmount})`);
        }

        // Save the updated contract list back to the database
        await this.saveAllData();
    }


    static async getNextIdFromMap(contractList) {
        let maxId = 0;
        for (const [key] of contractList.entries()) {
            const currentId = parseInt(key);
            if (currentId > maxId) {
                maxId = currentId;
            }
        }
        return maxId + 1;
    }



    // Generate contracts within the series
    static async generateContracts(expiryPeriod, series, seriesId, block) {
        let contracts = [];
        let expirationBlock = parseInt(block) + parseInt(expiryPeriod);

        for (let i = 0; i < series; i++) {
            contracts.push({
                id: `${seriesId}-${expirationBlock}`,
                expirationBlock: expirationBlock,
            });
            expirationBlock += parseInt(expiryPeriod);
        }
        return contracts;
    }

    static loadContractsFromDB() {
        return db.getDatabase('contractList').findAsync()
            .then(docs => {
                docs.forEach(doc => {
                    const { type, seriesId } = doc;
                    if (type === 'oracle') {
                        this.oracleList.set(seriesId, doc.data);
                    } else {
                        this.nativeList.set(seriesId, doc.data);
                    }
                });
            })
            .catch(error => {
                console.error('Error loading contracts from DB:', error);
                throw error;
            });
    }

   static async saveDataToDb(dataMap, dataType) {
        const dataArray = Array.from(dataMap.entries()).map(([id, data]) => ({
            id, data, type: dataType
        }));

        await Promise.all(dataArray.map(entry => 
            db.getDatabase('contractList').updateAsync({ id: entry.id }, entry, { upsert: true })
        ));
    }

    // Function to save contract series, oracle contracts, or native contracts
    static async saveAllData() {
        const instance = ContractRegistry.getInstance();
        await this.saveDataToDb(instance.contractList, 'contractSeries');
        await this.saveDataToDb(instance.oracleList, 'oracleContracts');
        await this.saveDataToDb(instance.nativeList, 'nativeContracts');
    }


     static async getNextId() {
        const instance = ContractRegistry.getInstance(); // Access singleton instance
        console.log('getting next id for instance '+JSON.stringify(instance))
        let maxId = 0;
        for (const [key] of instance.contractList.entries()) {
            const currentId = parseInt(key);
            if (currentId > maxId) {
                maxId = currentId;
            }
        }
        return maxId + 1;
    }

    static isValidSeriesId(seriesId) {
        const instance = ContractRegistry.getInstance(); // Access singleton instance
        // Check if the seriesId exists in the contract series registry
        // The registry could be a database, a map, or any other data structure
        // that stores information about the contract series in your system
        if (instance.contractList.has(seriesId)) {
            return true; // The seriesId is valid
        } else {
            return false; // The seriesId is not valid
        }
    }

    static async getContractSeries(seriesId) {
        const contractListDB = db.getDatabase('contractList');
        const doc = await contractListDB.findOneAsync({ id: seriesId, type: 'contractSeries' });
        return doc ? doc.data : null;
    }

    // ... other methods ...

    // Function to generate unique series ID
    static async getNextId() {
        const contractListDB = db.getDatabase('contractList');
        const docs = await contractListDB.findAsync({ type: 'contractSeries' });
        let maxId = docs.reduce((max, doc) => Math.max(max, parseInt(doc.id)), 0);
        return maxId + 1;
    }

    static async getAllContracts() {
        const contractListDB = db.getDatabase('contractList');
        const docs = await contractListDB.findAsync({ type: 'contractSeries' });
        return docs.map(doc => doc.data);
    }

    async hasOpenPositions(contract) {
        try {
            // Load the margin map for the contract's series ID
            let marginMap = await MarginMap.loadMarginMap(contract.seriesId);
            // Check if the margin map has any non-zero positions for this contract
            for (let [address, positionData] of marginMap.margins.entries()) {
                if (positionData.contracts > 0) {
                    return true; // Found an open position
                }
            }
            return false; // No open positions found
        } catch (error) {
            console.error('Error checking open positions for contract:', contract.seriesId, error);
            throw error;
        }
    }

    
    static async getContractType(contractId) {
        const contractInfo = await this.getContractInfo(contractId);
        if (!contractInfo) {
            throw new Error("Contract type not found for contract ID: " + contractId);
        }
        return contractInfo.native ? 'native' : 'oracle';
    }

    static async isNativeContract(contractId) {
        const contractInfo = await this.getContractInfo(contractId);
        return contractInfo ? contractInfo.native : false;
    }

    static async getContractInfo(contractId) {
        //console.log('retrieving db info for contract '+contractId)
        const contractListDB = db.getDatabase('contractList');
        const doc = await contractListDB.findOneAsync({ id: contractId, type: 'contractSeries' });
        if (!doc) {
            //console.log('Contract information not found for contract ID:' + JSON.stringify(contractId));

            return null;
        }
        return doc.data;
    }

    static async getNotionalValue(contractId) {
        
            // Assuming contractData is the data structure for the contract
            const contractData = await this.getContractInfo(contractId);
            //console.log('contract data in getNotionalValue '+JSON.stringify(contractData))
        try {
            if (contractData && contractData.native && contractData.native.notionalValue !== undefined) {
                const notionalValue = contractData.native.notionalValue;
                return notionalValue;
            } else {
                console.error(`Notional value not found for contractId: ${contractId}`);
                return 0; // or any default value
            }
        } catch (error) {
            console.error(`Error retrieving notional value for contractId ${contractId}:`, error);
            throw error;
        }
    };

    static async isInverse(contractId) {
        // Call the existing getContractInfo function
        const contractInfo = await this.getContractInfo(contractId);
        
        // Check if contractInfo exists and has the 'inverse' property
        if (contractInfo && typeof contractInfo.inverse !== 'undefined') {
            return contractInfo.inverse;
        }

        // Return false by default if the contract is not found or doesn't have the 'inverse' property
        return false;
    }

     // Function to get initial margin requirement for a contract
    static async getInitialMargin(contractId, price) {
        //console.log('checking contractId inside getInitialMargin '+contractId)
        const contractInfo = await ContractRegistry.getContractInfo(contractId);
        if (!contractInfo) {
            throw new Error(`Contract info not found for contract ID: ${contractId}`);
        }
        //console.log('getting contractInfo inside getInit Margin ' +JSON.stringify(contractInfo))
        let inverse = contractInfo.native.inverse;
        let notionalValue = contractInfo.native.notionalValue
        let leverage = contractInfo.native.leverage
        //console.log('inside getInitialMargin, inverse:'+inverse+ 'notional '+ notionalValue + 'lvg. '+ leverage + 'at price '+price)
        if (inverse) {
            // For inverse contracts, margin is calculated based on notional value
            return BigNumber(notionalValue).div(leverage).toNumber();
        } else {
            /*
            // For linear contracts, check collateral and calculate based on oracle price or property value
            const collateralValue = await ContractRegistry.getCollateralValue(contractInfo);
            return BigNumber(collateralValue).div(leverage);
            */
            return BigNumber(notionalValue).times(price).div(leverage).toNumber();
        }
    }

    // Helper function to get collateral value for linear contracts
    static async getCollateralValue(contractInfo) {
        const PropertyManager = require('./property.js')
        const OracleList = require('./oracle.js')
        const { collateralPropertyId, oracleId } = contractInfo;
        if (collateralPropertyId) {
            // If collateral is a property, use its value
            const propertyData = await PropertyManager.getPropertyData(collateralPropertyId);
            return propertyData ? propertyData.value : 0; // Example value fetching logic
        } else if (oracleId) {
            // If collateral is based on an oracle, use the latest price
            const latestPrice = await OracleRegistry.getOracleData(oracleId);
            return latestPrice || 0; // Example oracle price fetching logic
        }
        return 0; // Default to 0 if no valid collateral source
    }

    // Method to get the collateral property ID for a given contract ID
    static async getCollateralId(contractId) {
        // Load contract information
        const contractInfo = await ContractRegistry.getContractInfo(contractId);

        // Check if contract information is available
        if (!contractInfo) {
            console.log(`Contract info not found for contract ID: ${contractId}`);
        }
        //console.log('getting contract info for '+contractId +' '+JSON.stringify(contractInfo.native.collateralPropertyId))
        // Return the collateral property ID from the contract information
        //console.log('returning collateral id '+contractInfo.native.collateralPropertyId+ ' type of '+typeof contractInfo.native.collateralPropertyId)
        return contractInfo.native.collateralPropertyId;
    }

        // In the contract order addition process
    static async moveCollateralToReserve(sender, contractId, amount,price, block) {
        const TallyMap = require('./tally.js')
        const initialMarginPerContract = await ContractRegistry.getInitialMargin(contractId, price);
        //console.log('initialMarginPerContract '+initialMarginPerContract)
        const collateralPropertyId = await ContractRegistry.getCollateralId(contractId)
        //console.log('collateralPropertyId '+collateralPropertyId)
        const totalInitialMargin = BigNumber(initialMarginPerContract).times(amount).toNumber();
        console.log('Total Initial Margin to reserve ' +totalInitialMargin+' '+sender+' '+collateralPropertyId)
        // Move collateral to reservd position
        await TallyMap.updateBalance(sender, collateralPropertyId, -totalInitialMargin, totalInitialMargin, 0, 0, 'contractReserveInitMargin',block);
        return totalInitialMargin
    }

   static async moveCollateralToMargin(sender, contractId, amount, price, orderPrice,side, initMargin,channel,channelAddr,block,feeInfo){
        const TallyMap = require('./tally.js')
        const MarginMap = require('./marginMap.js')
        const marginMap = await MarginMap.getInstance(contractId)
        console.log('looking at feeInfo obj '+JSON.stringify(feeInfo))
        //console.log('checking instance of marginMap '+ JSON.stringify(marginMap))
        const initialMarginPerContract = await ContractRegistry.getInitialMargin(contractId, price);
        //console.log('initialMarginPerContract '+initialMarginPerContract)
        const collateralPropertyId = await ContractRegistry.getCollateralId(contractId)
        //console.log('collateralPropertyId '+collateralPropertyId)
        let totalInitialMargin = BigNumber(initialMarginPerContract).times(amount).toNumber();
        console.log('Total Initial Margin ' +totalInitialMargin+' '+amount+' '+initialMarginPerContract+ ' '+initMargin+' '+price)
        // Move collateral to reservd position
                    let contractUndo = 0
                    let excessMargin
            if(orderPrice>price&&side==true&&excessMargin!=0&&channel==false){
                    excessMargin = initMargin -totalInitialMargin
                    console.log('calling move margin in buyer excess margin channel false '+sender+' '+excessMargin)
                    //contract was bid higher than the fill, the initMargin in reserve is too high and will be returned to available
                     await TallyMap.updateBalance(sender, collateralPropertyId, excessMargin, -excessMargin,0, 0, 'returnExcessMargin',block);
            }else if(orderPrice<price&&side==false&&excessMargin!=0&&channel==false){
                    excessMargin = totalInitialMargin-initMargin
                    const hasSufficientBalance = await TallyMap.hasSufficientBalance(sender, collateralPropertyId, excessMargin);
                    if(hasSufficientBalance.hasSufficient==false){
                        contractUndo = BigNumber(hasSufficientBalance.shortfall)
                                              .dividedBy(initialMarginPerContract)
                                              .decimalPlaces(0, BigNumber.ROUND_CEIL)
                                              .toNumber();
                        amount -= contractUndo
                        totalInitialMargin = BigNumber(initialMarginPerContract).times(amount).toNumber();                         
                        excessMargin=totalInitialMargin-initMargin                               
                    //contract was offered lower than the fill, init Margin in reserve is too high extra will return to available
                    console.log('calling move margin in seller excess margin channel false, insufficient Balance '+sender+' '+excessMargin)
                        await TallyMap.updateBalance(sender, collateralPropertyId, excessMargin, -excessMargin, 0, 0, 'returnExcessMargin',block);    
                    }else{
                    console.log('calling move margin in seller excess margin channel false, sufficient Balance '+sender+' '+excessMargin)                
                       await TallyMap.updateBalance(sender, collateralPropertyId, -excessMargin, excessMargin, 0, 0, 'pullingExcessMargin',block);  
                    }  
            }
            console.log('checking feeInfo obj again '+JSON.stringify(feeInfo))
        if(channel==false){
             console.log('calling move margin standard '+sender+' '+totalInitialMargin)
             if(feeInfo.buyFeeFromReserve&&side==true){
                totalInitialMargin-=feeInfo.buyerFee
             }else if(feeInfo.sellFeeFromReserve&&side==false){
                totalInitialMargin-=feeInfo.sellerFee
             }
             await TallyMap.updateBalance(sender, collateralPropertyId, 0, -totalInitialMargin, totalInitialMargin, 0, 'contractTradeInitMargin',block);
        }else if(channel==true){
            if(feeInfo.buyFeeFromReserve&&side==true){
                totalInitialMargin-=feeInfo.buyerFee
            }else if(feeInfo.sellFeeFromReserve&&side==false){
                totalInitialMargin-=feeInfo.sellerFee
            }
            console.log('about to move initMargin from channel '+channelAddr+' '+collateralPropertyId+' '+totalInitialMargin)
            await TallyMap.updateBalance(channelAddr, collateralPropertyId, 0, -totalInitialMargin, 0, 0, 'contractTradeInitMargin',block);
            await TallyMap.updateBalance(sender, collateralPropertyId, 0, 0, totalInitialMargin, 0, 'contractTradeInitMargin',block);
        }  
        var position = await marginMap.setInitialMargin(sender, contractId, totalInitialMargin);
        return position
    }           


    static async getPriceAtBlock(contractId, blockHeight) {
        let isOracleContract = await ContractRegistry.isOracleContract(contractId);
        let oracleId = null;
        let propertyId1 = null;
        let propertyId2 = null;
        let latestData;
        let oracleDataDB = db.getDatabase('contractList')
        if (isOracleContract) {
            oracleId = await ContractRegistry.getOracleId(contractId);
            latestData = await oracleDataDB.findAsync({ oracleId: oracleId });
        } else {
            let info = await ContractRegistry.getContractInfo(contractId);
            propertyId1 = info.native.native.onChainData[0];
            propertyId2 = info.native.native.onChainData[1];
            latestData = await volumeIndexDB.findOneAsync({ propertyId1: propertyId1, propertyId2: propertyId2 });
        }

        // Filter data to get updates before the given blockHeight
        const filteredData = latestData.filter(entry => entry.blockHeight < blockHeight);

        if (filteredData.length === 0) {
            // No data available before the given blockHeight
            return null;
        }

        // Sort filtered data by block height in descending order
        const sortedData = filteredData.sort((a, b) => b.blockHeight - a.blockHeight);
        const latestBlockData = sortedData[0]; // Get the latest data before the given blockHeight
        const lastPriceEntry = latestBlockData[latestBlockData.length - 1];
        const priceBlockHeight = lastPriceEntry.blockHeight; // Block height of the price data

        // Check if the block height of the price data is less than the provided blockHeight
        if (priceBlockHeight >= blockHeight) {
            // If not, find the latest data before the provided blockHeight
            for (let i = 1; i < sortedData.length; i++) {
                const blockData = sortedData[i];
                const blockDataPrice = blockData[blockData.length - 1].blockHeight;
                if (blockDataPrice < blockHeight) {
                    const lastPriceEntry = blockData[blockData.length - 1];
                    return lastPriceEntry.data.price;
                }
            }
            return null; // No valid price data found before the provided blockHeight
        }

        return lastPriceEntry.data.price;
    }

     // Determine if a contract is an oracle contract
    static async isOracleContract(contractId) {
        const contractInfo = await ContractRegistry.getContractInfo(contractId);
        //console.log(contractInfo.native.native,Boolean(contractInfo.native.native===false))
        return contractInfo && contractInfo.native.native === false;
    }

      // Determine a contract's oracle
    static async getOracleId(contractId) {
        const contractInfo = await ContractRegistry.getContractInfo(contractId);
        //console.log(contractInfo.native.native,Boolean(contractInfo.native.native===false))
        return contractInfo.native.underlyingOracleId;
    }

    static async getLatestOracleData(oracleId){
         // Access the database where oracle data is stored
            const oracleDataDB = db.getDatabase('oracleData');
            // Query the database for the latest oracle data for the given contract
                       
            const latestData = await oracleDataDB.findOneAsync({ oracleId: oracleId });
            if (latestData) {
                const sortedData = [latestData].sort((a, b) => b.blockHeight - a.blockHeight);
                const latestBlockData = sortedData[0];

                return latestBlockData
            }else{
                console.log('no oracle data found '+JSON.stringify(latestData))
                return null
            }

    }

    // Calculate the 1-hour funding rate for an oracle contract
    // static async calculateFundingRate(contractId) {
    //     const isOracle = await ContractRegistry.isOracleContract(contractId);
    //     if (!isOracle) {
    //         return 0; // Return zero for non-oracle contracts
    //     }

    //     // Get oracle data for the last 24 blocks
    //     const Oracles = require('./Oracles');
    //     const oracleData = await Oracles.getLast24BlocksData(contractId);
    //     const avgOraclePrice = ContractRegistry.calculateAveragePrice(oracleData);

    //     // Placeholder for the logic to get the average trade price for the contract
    //     // const avgTradePrice = ...;

    //     // Calculate the funding rate based on the difference between oracle price and trade price
    //     const priceDifference = avgTradePrice / avgOraclePrice;
    //     let fundingRate = 0;

    //     if (priceDifference > 1.0005) {
    //         fundingRate = (priceDifference - 1.0005) * oracleData.length; // Example calculation
    //     } else if (priceDifference < 0.9995) {
    //         fundingRate = (0.9995 - priceDifference) * oracleData.length; // Example calculation
    //     }

    //     return fundingRate;
    // }

    // async applyFundingRateToSystem(contractId,block) {
    //     const fundingRate = await ContractsRegistry.calculateFundingRate(contractId);
        
    //     // Apply funding rate to marginMap+tallyMap
    //     for (const [address, position] of marginMap.entries()) {
    //         if (position.contractId === contractId) {
    //             const fundingAmount = calculateFundingAmount(position.size, fundingRate);
    //             TallyMap.updateBalance(address, contractId, fundingAmount,0,0,0,'funding',block);
    //             marginMap.updatePosition(address, contractId, fundingAmount);
    //         }
    //     }

    //     // Apply funding rate to vaulted contracts
    //     for (const [vaultId, vault] of SynthRegistry.vaults.entries()) {
    //         if (vault.contractId === contractId) {
    //             const fundingAmount = ContractRegistry.calculateFundingAmount(vault.contractBalance, fundingRate);
    //             SynthRegistry.applyPerpetualSwapFunding(vaultId, contractId, fundingAmount);
    //         }
    //     }

    //     // Save changes
    //     await TallyMap.save();
    //     await marginMap.save();
    //     await SynthRegistry.saveVaults();
    // }

    static calculateFundingAmount(contractSize, fundingRate) {
        return contractSize * fundingRate;
    }


    // Calculate the average price from oracle data
    static calculateAveragePrice(oracleData) {
        if (!oracleData || oracleData.length === 0) return 0;

        const total = oracleData.reduce((acc, data) => acc + data.price, 0);
        return total / oracleData.length;
    }

    // Save funding event for a contract
    static async saveFundingEvent(contractId, fundingRate, blockHeight) {
        const dbInstance = require('./db.js');
        const fundingEvent = { contractId, fundingRate, blockHeight };
        await dbInstance.getDatabase('fundingEvents').insertAsync(fundingEvent);
    }

    // Load funding events for a contract
    static async loadFundingEvents(contractId) {
        const dbInstance = require('./db.js');
        const fundingEvents = await dbInstance.getDatabase('fundingEvents').findAsync({ contractId: contractId });
        return fundingEvents.map(doc => doc);
    }
}

// Usage:

/*const oracleContracts = registry.getContractsByOracle(5); 

const propertyContracts = registry.getContractsByProperties(1, 2);*/

module.exports = ContractRegistry;