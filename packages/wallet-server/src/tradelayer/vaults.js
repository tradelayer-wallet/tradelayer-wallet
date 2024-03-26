const db = require('./db.js');
const PropertyManager = require('./PropertyManager');
const ContractsRegistry = require('./ContractsRegistry');
const MarginMap = require('./marginMap');

class SynthRegistry {
      constructor() {
        this.vaults = new Map();
        this.syntheticTokens = new Map();
        this.nextVaultId = 1; // Initialize with a starting value for vault IDs
    }

    // Create a new vault for a synthetic token
    async createVault(propertyId, contractId) {
        const vaultId = this.generateVaultId();
        this.vaults.set(vaultId, { propertyId, contractId, amount: 0, address: '' /* ... other vault details ... */ });
        await this.saveVault(vaultId);
        return vaultId;
    }

    // Update the amount in a vault
    async updateVault(vaultId, amount) {
        if (!this.vaults.has(vaultId)) {
            throw new Error('Vault not found');
        }
        const vault = this.vaults.get(vaultId);
        vault.amount += amount;
        await this.saveVault(vaultId);
    }

    // Get vault information
    getVault(vaultId) {
        return this.vaults.get(vaultId);
    }

    // Register a new synthetic token
    async registerSyntheticToken(syntheticTokenId, vaultId, initialAmount) {
        this.syntheticTokens.set(syntheticTokenId, { vaultId, amount: initialAmount });
        await this.saveSyntheticToken(syntheticTokenId);
    }

    // Check if a synthetic token exists
    exists(syntheticTokenId) {
        return this.syntheticTokens.has(syntheticTokenId);
    }

    // Get vault ID for a synthetic token
    getVaultId(syntheticTokenId) {
        return this.syntheticTokens.get(syntheticTokenId)?.vaultId;
    }
    
    generateVaultId() {
            return this.nextVaultId++; // Increment and return the next vault ID
    }

    // Persist vault data to the database
    async saveVault(vaultId) {
        const vaultDB = dbInstance.getDatabase('vaults');
        await vaultDB.updateAsync(
          { _id: `vault-${vaultId}` },
          { _id: `vault-${vaultId}`, value: JSON.stringify(this.vaults.get(vaultId)) },
          { upsert: true }
        );
    }

    // Persist synthetic token data to the database
    async saveSyntheticToken(syntheticTokenId) {
        const synthDB = dbInstance.getDatabase('syntheticTokens');
        await synthDB.updateAsync(
          { _id: `synth-${syntheticTokenId}` },
          { _id: `synth-${syntheticTokenId}`, value: JSON.stringify(this.syntheticTokens.get(syntheticTokenId)) },
          { upsert: true }
        );
    }

    // Method to transfer synthetic currency units
    async sendSyntheticCurrency(senderAddress, receiverAddress, syntheticTokenId, amount, channelTransfer) {
        const vaultId = this.getVaultId(syntheticTokenId);
        if (!vaultId) {
            throw new Error('Vault not found for the given synthetic token ID');
        }

        if(channelTransfer==false){

            // Check if sender has sufficient balance
            const senderBalance = await TallyMap.getAddressBalance(senderAddress, syntheticTokenId);
            if (senderBalance < amount) {
                throw new Error('Insufficient balance for transfer');
            }

            // Update balances in TallyMap
            await TallyMap.updateBalance(senderAddress, syntheticTokenId, -amount);
            await TallyMap.updateBalance(receiverAddress, syntheticTokenId, amount);
        }else{
             // Get the channel information
                const channel = await this.getChannel(senderAddress);
                if (!channel) {
                    throw new Error('Channel not found');
                }

                // Implement the logic to check if the sender has sufficient balance in the channel
                // and to update the channel balances accordingly
                // ...

        }
    }


    async tradeSyntheticCurrency(tradeDetails, channelTrade) {
        const { syntheticTokenId, amount, price, sellerAddress, buyerAddress } = tradeDetails;

        if(channelTrade==false){

            // Add the order to the order book
            const orderBookKey = `synth-${syntheticTokenId}`;
            await Orderbook.insertOrder(orderBookKey, tradeDetails);

            // Match orders in the order book
            const matchResult = await Orderbook.matchOrders(orderBookKey);
            if (matchResult.matches && matchResult.matches.length > 0) {
                // Process matches
                // This might involve transferring synthetic currency units, updating vaults, etc.
                // ...
            }
        }else{

            // Extract trade details
            const { syntheticTokenId, amount, price, sellerAddress, buyerAddress } = tradeDetails;

            // Get the channel information
            const channel = await this.getChannel(sellerAddress);
            if (!channel) {
                throw new Error('Channel not found');
            }

            // Implement the logic to record and process the trade within the channel
            // This might involve updating balances, checking for sufficient funds, etc.
            // ...
        }
    }

    // Method to post synthetic currency as margin
        
    async postMargin(address, syntheticTokenId, amount, contractId) {
        // Validate the synthetic token ID
        const { underlyingPropertyId, hedgeContractId, vaultId } = SynthRegistry.parseSyntheticTokenId(syntheticTokenId);
        if (!SynthRegistry.isValidSyntheticTokenId(underlyingPropertyId, hedgeContractId, vaultId)) {
            throw new Error('Invalid synthetic token ID');
        }

        // Check if the address has sufficient balance of the synthetic token
        const syntheticTokenBalance = await TallyMap.getAddressBalance(address, syntheticTokenId);
        if (syntheticTokenBalance < amount) {
            throw new Error('Insufficient balance for margin posting');
        }

        // Move synthetic token from available balance to margin balance in TallyMap
        await TallyMap.updateBalance(address, syntheticTokenId, -amount, 0, amount, 0);

        // Update the MarginMap for the contract
        const marginMap = await MarginMap.loadMarginMap(contractId);
        marginMap.updateMargin(address, amount, syntheticTokenId); // assuming MarginMap has a method to update margin with synthetic token ID

        // Persist the updated MarginMap
        await MarginMap.saveMarginMap(contractId, marginMap);

        console.log(`Posted ${amount} of synthetic token ID ${syntheticTokenId} as margin for contract ID ${contractId}`);
    }

    // Method to generate a compound synthetic token identifier
    generateSyntheticTokenId(underlyingPropertyId, hedgeContractId, vaultId) {
        // Implement logic to generate a compound identifier
        return `${underlyingPropertyId}-${hedgeContractId}-${vaultId}`;
    }

    // Method to parse a compound synthetic token identifier
    parseSyntheticTokenId(syntheticTokenId) {
        const parts = syntheticTokenId.split('-');
        if (parts.length !== 3) {
            throw new Error('Invalid synthetic token ID format');
        }

        const [underlyingPropertyId, hedgeContractId, vaultId] = parts.map(part => parseInt(part));
        return { underlyingPropertyId, hedgeContractId, vaultId };
    }


    // Method to find a vault based on a compound synthetic token identifier
    findVaultIdByCompoundIdentifier(underlyingPropertyId, hedgeContractId) {
        for (const [vaultId, vaultData] of this.vaults.entries()) {
            if (vaultData.underlyingPropertyId === underlyingPropertyId && 
                vaultData.hedgeContractId === hedgeContractId) {
                return vaultId;
            }
        }
        return null; // or throw an error if preferred
    }


    // Method to reuse vault numbers
    reuseVaultNumber() {
        // Example logic to reuse a vault number
        const availableVaults = Array.from(this.vaults.keys()).filter(vaultId => {
            const vault = this.vaults.get(vaultId);
            return vault.isEmpty || vault.isExpired; // Assuming vaults have 'isEmpty' or 'isExpired' properties
        });

        return availableVaults.length > 0 ? availableVaults[0] : this.generateNewVaultId();
    }


    // Load vaults and synthetic tokens from the database
    static async loadFromDatabase() {
        // Example loading logic for vaults
        const vaultsData = await db.getDatabase('vaults').findAsync();
        vaultsData.forEach(vault => {
            this.vaults.set(vault._id, vault.data);
        });

        // Example loading logic for synthetic tokens
        const syntheticTokensData = await db.getDatabase('syntheticTokens').findAsync();
        syntheticTokensData.forEach(synth => {
            this.syntheticTokens.set(synth._id, synth.data);
        });
    }


    // Function to check if a property ID is a synthetic token
    static isSyntheticProperty(propertyId) {
        // Implement logic to check if the property ID is compound (contains '-')
        if (propertyId.toString().includes('-')) {
            const [underlyingPropertyId, hedgeContractId] = propertyId.toString().split('-');
            // Implement checks to validate the underlyingPropertyId and hedgeContractId
            return this.isValidPropertyId(underlyingPropertyId) && this.isValidContractId(hedgeContractId);
        }
        return false;
    }

    // Function to parse a compound synthetic token ID
    static parseSyntheticTokenId(syntheticTokenId) {
        const parts = syntheticTokenId.split('-');
        if (parts.length === 3) {
            const [underlyingPropertyId, hedgeContractId, vaultId] = parts;
            // Validate parts and return the parsed data
            return { underlyingPropertyId, hedgeContractId, vaultId };
        }
        throw new Error('Invalid synthetic token ID format');
    }

    // Function to validate a property ID
    static async isValidPropertyId(propertyId) {
        try {
            // Load property data from the PropertyManager
            await PropertyManager.load();
            const propertyData = PropertyManager.propertyIndex.get(parseInt(propertyId));
            return Boolean(propertyData); // True if property exists, false otherwise
        } catch (error) {
            console.error(`Error validating property ID ${propertyId}:`, error);
            return false;
        }
    }

    // Function to validate a contract ID
    static async isValidContractId(contractId) {
        try {
            // Check if the contract exists in the ContractsRegistry
            const contractInfo = await ContractsRegistry.getContractInfo(contractId);
            return Boolean(contractInfo); // True if contract exists, false otherwise
        } catch (error) {
            console.error(`Error validating contract ID ${contractId}:`, error);
            return false;
        }
    }

    async applyPerpetualSwapFunding(vaultId, contractId, fundingRate) {
        const vault = this.vaults.get(vaultId);
        if (!vault) {
            throw new Error('Vault not found');
        }

        // Query contract balance in the vault for the specified contractId
        const contractBalance = vault.contracts[contractId];
        if (!contractBalance) {
            console.log(`No contract balance found for contract ID ${contractId} in vault ${vaultId}`);
            return;
        }

        // Calculate the funding amount based on the funding rate and the contract balance
        const fundingAmount = contractBalance * fundingRate;

        // Apply the funding amount to the contract's balance in the vault
        vault.contracts[contractId] += fundingAmount;

        // Optionally, adjust the total amount in the vault if needed
        // vault.amount += fundingAmount; // Uncomment and adjust as necessary

        // Save the updated vault
        await this.saveVault(vaultId);

        console.log(`Applied funding to contract ${contractId} in vault ${vaultId}: ${fundingAmount}`);
    }

    async rebaseSyntheticCurrency(vaultId, changeInValue) {
        const syntheticTokenId = this.findSyntheticTokenIdByVaultId(vaultId);
        if (!syntheticTokenId) {
            throw new Error('Synthetic token not found for the given vault ID');
        }

        const syntheticToken = this.syntheticTokens.get(syntheticTokenId);
        if (!syntheticToken) {
            throw new Error('Synthetic token not found');
        }

        // Calculate the new amount based on the change in value
        const newAmount = syntheticToken.amount * (1 + changeInValue);

        // Update the synthetic token's amount
        syntheticToken.amount = newAmount;

        // Save the updated synthetic token
        await this.saveSyntheticToken(syntheticTokenId);

        console.log(`Rebased synthetic currency ${syntheticTokenId}: new amount ${newAmount}`);
    }

    findSyntheticTokenIdByVaultId(vaultId) {
        // Logic to find the synthetic token ID associated with a given vault ID
        for (const [synthId, tokenInfo] of this.syntheticTokens.entries()) {
            if (tokenInfo.vaultId === vaultId) {
                return synthId;
            }
        }
        return null;
    }

    // ... other necessary methods ...
}

module.exports = SynthRegistry;
