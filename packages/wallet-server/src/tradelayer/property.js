const db = require('./db.js');
const path = require('path');

class PropertyManager {
    static instance = null;

    constructor() {
        if (PropertyManager.instance) {
            return PropertyManager.instance;
        }

        this.propertyIndex = new Map();
        this.ammIndex = new Map(); // Initialize AMM index
        PropertyManager.instance = this;
    }

    static getInstance() {
        if (!PropertyManager.instance) {
            PropertyManager.instance = new PropertyManager();
        }
        return PropertyManager.instance;
    }

    static async load() {
        console.log('loading property list');
        try {
            const instance = PropertyManager.getInstance();
            const propertyIndexEntry = await db.getDatabase('propertyList').findOneAsync({ _id: 'propertyIndex' });
            if (propertyIndexEntry && propertyIndexEntry.value) {
                // Check if the value is a string and parse it as JSON
                const data = typeof propertyIndexEntry.value === 'string' ? JSON.parse(propertyIndexEntry.value) : propertyIndexEntry.value;

                // Ensure the data is an array of arrays before converting it to a Map
                if (Array.isArray(data) && data.every(item => Array.isArray(item) && item.length === 2)) {
                    instance.propertyIndex = new Map(data);
                } else {
                    console.error('Invalid data format for propertyIndex:', data);
                    instance.propertyIndex = new Map();
                }
            } else {
                instance.propertyIndex = new Map(); // Initialize with an empty Map if no data is found
            }
        } catch (error) {
            console.error('Error loading data from NeDB:', error);
            instance.propertyIndex = new Map(); // Use an empty Map in case of an error
        }
    }


    async getNextPropertyId() {
        await PropertyManager.load();
        let maxId = 0;
        for (let key of this.propertyIndex.keys()) {
            maxId = Math.max(maxId, key);
        }
        return maxId + 1;
    }

    async createToken(ticker, totalInCirculation, type, whitelistId, backupAddress) {
        // Check if the ticker already exists

        if (this.propertyIndex.has(ticker)) {
            return new (`Error: Ticker "${ticker}" already exists.`);
        }
        for (let [key, value] of this.propertyIndex.entries()) {
            if (value.ticker === ticker) {
                return Error(`Ticker "${ticker}" already exists.`);
            }
        }

        const propertyId = await this.getNextPropertyId();
        await this.addProperty(propertyId, ticker, totalInCirculation, type, whitelistId, backupAddress);
        console.log(`Token created: ID = ${propertyId}, Ticker = ${ticker}, Type = ${type}`);
        return propertyId;
      }

    async addProperty(propertyId, ticker, totalInCirculation, type, whitelistId, backupAddress) {
        
        const propertyTypeIndexes = {
            'Fixed': 1,
            'Managed': 2,
            'Native': 3,
            'Vesting': 4,
            'Synthetic': 5,
            'Non-Fungible': 6,
        };

        if (!propertyTypeIndexes[type]) {
            throw new Error('Invalid property type.');
        }

        this.propertyIndex.set(propertyId, {
            ticker,
            totalInCirculation,
            type: propertyTypeIndexes[type],
            whitelistId: whitelistId,
            backupAddress: backupAddress
        });
        await this.save();
        return console.log('updated Property Index '+this.propertyIndex)
    }

    async inspectPropertyIndex() {
        const propertyManager = PropertyManager.getInstance();

        // Load the properties
        await PropertyManager.load();

        // Convert the Map into an array of key-value pairs
        const propertiesArray = Array.from(propertyManager.propertyIndex.entries());

        // Alternatively, convert the Map into an object for easier visualization
        const propertiesObject = Object.fromEntries(propertyManager.propertyIndex);

        console.log('Properties as Array:', propertiesArray);
        console.log('Properties as Object:', propertiesObject);
    }

    static async getAMM(propertyId1, propertyId2) {
        const pairKey = `${propertyId1}-${propertyId2}`;
        const ammInstance = PropertyRegistry.getInstance().ammIndex.get(pairKey);

        if (ammInstance) {
            return ammInstance;
        } else {
            // If AMM instance doesn't exist, initialize it
            const newAMM = await initializeAMM(propertyId1, propertyId2); // You need to define the initialization logic
            PropertyRegistry.getInstance().ammIndex.set(pairKey, newAMM);
            return newAMM;
        }
    }


    async save() {

        const propertyIndexJSON = JSON.stringify([...this.propertyIndex.entries()]);
        const propertyIndexData = { _id: 'propertyIndex', value: propertyIndexJSON };

        await new Promise((resolve, reject) => {
            db.getDatabase('propertyList').update({ _id: 'propertyIndex' }, propertyIndexData, { upsert: true }, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    static async getPropertyData(propertyId) {
        const instance = PropertyManager.getInstance();

        // If the propertyIndex is empty, load it first
        if (instance.propertyIndex.size === 0) {
            await PropertyManager.load();
        }

        // Get the property data from the index
        const propertyData = instance.propertyIndex.get(propertyId);

        // If property data is found, return it; otherwise, return null
        if (propertyData !== undefined) {
            return propertyData;
        } else {
            return null;
        }
    }

    static async getPropertyIndex() {
        const instance = PropertyManager.getInstance();

        // If the propertyIndex is empty, load it first
        if (instance.propertyIndex.size === 0) {
            await PropertyManager.load();
        }
        
        // Transform the Map into an array of objects, each representing a property
        return Array.from(instance.propertyIndex).map(([id, property]) => ({
            id,
            ticker: property.ticker,
            totalInCirculation: property.totalInCirculation,
            type: property.type
        }));
    }

     /**
     * Checks if the given propertyId is a synthetic token.
     * @param {number} propertyId - The ID of the property to check.
     * @returns {boolean} - True if the property is a synthetic token, false otherwise.
     */
    static async isSyntheticToken(propertyId) {
        if(!this.propertyIndex){await this.load();}  // Make sure the property list is loaded
        const propertyInfo = this.propertyIndex.get(propertyId);
        // Check if the propertyInfo is valid and the type is 5 (synthetic)
        return propertyInfo && propertyInfo.type === 5;
    }

    async grantTokens(propertyId, recipient, amount,block) {
        const propertyData = await this.getPropertyData(propertyId);
        if (!propertyData) {
            throw new Error(`Property with ID ${propertyId} not found.`);
        }

        // Update managed supply
        propertyData.totalInCirculation += amount;

        // Update tally map to credit the amount to recipient
        await TallyMap.credit(recipient, propertyId, amount,0,0,0,'grantToken',block);

        // Save changes
        await this.save();
        console.log(`Granted ${amount} managed tokens to ${recipient} for property ${propertyId}.`);
    }

    async redeemTokens(propertyId, recipient, amount,block) {
        const propertyData = await this.getPropertyData(propertyId);
        if (!propertyData) {
            throw new Error(`Property with ID ${propertyId} not found.`);
        }

        // Ensure enough managed tokens available for redemption
        if (propertyData.totalInCirculation < amount) {
            throw new Error(`Insufficient managed tokens for redemption for property ${propertyId}.`);
        }

        // Update managed supply
        propertyData.totalInCirculation -= amount;

        // Update tally map to debit the amount from recipient
        await TallyMap.updateBalance(recipient, propertyId, amount,0,0,0,'redeemToken',block);

        // Save changes
        await this.save();
        console.log(`Redeemed ${amount} managed tokens from ${recipient} for property ${propertyId}.`);
    }


    // ... other methods like verifyIfManaged, updateAdmin ...
}

module.exports = PropertyManager;
