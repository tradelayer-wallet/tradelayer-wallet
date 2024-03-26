const InsuranceFund = require('./insurance.js');
const PropertyManager = require('./property.js'); // Assuming Property has the createToken method
const ContractsRegistry = require('./contractRegistry'); // Assuming this is the correct import

class TradeLayerManager {
    static instance = null;

    constructor(adminAddress) {
        if (!TradeLayerManager.instance) {
            this.adminAddress = adminAddress;
            TradeLayerManager.instance = this;
        }
    }

    static async getInstance(adminAddress){
        if (!TradeLayerManager.instance) {
            TradeLayerManager.instance = new TradeLayerManager(adminAddress);
            console.log('generating new TL manager')
        }
        console.log('returning TL Manager')
        return TradeLayerManager.instance;
    }

    async initializeTokens() {
        const TallyMap = require('./tally.js');
         const alreadyInitialized = await TallyMap.checkInitializationFlag();
        
        if(this.adminAddress==undefined||this.adminAddress==null){
            this.adminAddress="tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8"
        }
         
        if (!alreadyInitialized) {
            var TLTokenId = 1;
            const TLTotalAmount = 1500000;

            var TLVESTTokenId = 2;
            const TLVESTTotalAmount = 1250000;
            var amountToInsuranceFund = 250000;
            const propertyManager = PropertyManager.getInstance()
            TLTokenId = await propertyManager.createToken('TL', TLTotalAmount, 'Fixed');
            TLVESTTokenId = await propertyManager.createToken('TLVEST', TLVESTTotalAmount, 'Vesting');

            console.log('verifying that propertyid numbering is consistent '+TLTokenId,TLVESTTokenId)
            var insuranceFund = new InsuranceFund(1,0,0.5)
            // Distribute initial amount to insurance fund
            insuranceFund.deposit(TLVESTTokenId, amountToInsuranceFund);
            insuranceFund.deposit(TLTokenId,amountToInsuranceFund,true)
            
            await TallyMap.updateBalance(this.adminAddress, TLTokenId, TLTotalAmount-TLVESTTotalAmount, 0, 0, TLTotalAmount - amountToInsuranceFund);
            await TallyMap.updateBalance(this.adminAddress, TLVESTTokenId, TLVESTTotalAmount - amountToInsuranceFund, 0, 0, 0);
            
            const balances = await TallyMap.getAddressBalances(this.adminAddress)

            // After initializing tokens, set the flag
            await TallyMap.setInitializationFlag();
            return balances
        }
    }

    static initializeContractSeries() {
        const LTC_TL_Future_ContractId = 1;
        const contractProperties = {
            // Define contract properties such as margin requirements, expiry, etc.
            // Example properties:
            initialMargin: 0.1, // 10%
            maintenanceMargin: 0.05, // 5%
            expiry: 'perp', //need to assure that perp or 0 or null etc. codes to perpetual
            index: [1, 0], //LTC vs. TL, need to assure that the propertyid for TL init's to 1 and that 0 corresponds to LTC UTXO
            expiryInterval: 17280,
            seriesLength: 6
        };

        // Create the contract series
        ContractsRegistry.createContractSeries(LTC_TL_Future_ContractId, 'native', contractProperties);

        // Additional setup if required, such as initializing order books, setting initial market conditions, etc.
    }

    static updateVesting(cumulativeVolumeLTC, currentBlockVolumeLTC) {
        const logScaleMin = 1000;
        const logScaleMax = 100000000;
        let vestingFactor = Math.log(cumulativeVolumeLTC) / Math.log(logScaleMax);
        vestingFactor = Math.min(Math.max(vestingFactor, 0), 1);
        const vestingAmount = vestingFactor * currentBlockVolumeLTC;
        // Update vesting balances per address
    }

    static calculateTradeRebates(cumulativeVolumeLTC) {
	    const baseVolume = 1000; // The volume where rebate calculation starts
	    const minRebate = 0.000003125; // The minimum rebate value
	    const maxRebate = 0.0001; // The maximum rebate value

	    // Ensure cumulative volume is at least at the base volume
	    if (cumulativeVolumeLTC < baseVolume) {
	        return maxRebate; // Return max rebate if below base volume
	    }

	    // Calculate the rebate using a logarithmic scale
	    const scale = Math.log(cumulativeVolumeLTC / baseVolume) / Math.log(100000000 / baseVolume);
	    const rebate = maxRebate - scale * (maxRebate - minRebate);

	    // Ensure the rebate is not less than the minimum
	    return Math.max(rebate, minRebate);
	}

    static performBuyback(feeCaches) {
        feeCaches.forEach(cache => {
            const orderbook = this.fetchOrderbookForToken(cache.tokenId);
            const buybackAmount = this.calculateBuybackAmount(cache, orderbook);
            // Execute buyback transaction
        });
    }

    static fetchOrderbookForToken(tokenId) {
        // Fetch the orderbook for the given token
        // Implementation depends on your system's data sources
    }

    static calculateBuybackAmount(cache, orderbook) {
        let availableFunds = cache.funds;
        let totalBuybackAmount = 0;

        for (const order of orderbook) {
            const orderCost = order.price * order.amount;
            if (availableFunds >= orderCost) {
                totalBuybackAmount += order.amount;
                availableFunds -= orderCost;
            } else {
                const partialAmount = availableFunds / order.price;
                totalBuybackAmount += partialAmount;
                availableFunds = 0;
                break;
            }

            if (availableFunds <= 0) break;
        }

        return totalBuybackAmount;
    }
}

module.exports = TradeLayerManager;
