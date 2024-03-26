const level = require('level');

// Database setup
const { db, txIndexDB,propertyListDB,oracleListDB,contractListDB,tallyMapDB,marginMapsDB, whitelistsDB, clearingDB, consensusDB,persistenceDB} = require('./db.js')

class BlockchainPersistence {
    constructor() {
        this.lastKnownBlockHash = '';
        this.checkpointInterval = 1000
    }

    /**
     * Updates the last known block hash.
     * @param {String} blockHash - The hash of the latest block
     */
    async updateLastKnownBlock(blockHash) {
        try {
            await db.put('lastKnownBlock', blockHash);
            this.lastKnownBlockHash = blockHash;
            console.log('Last known block updated:', blockHash);
        } catch (error) {
            console.error('Error updating last known block:', error);
        }
    }

    /**
     * Detects a blockchain reorganization.
     * @param {String} currentBlockHash - The hash of the current block
     * @returns {Boolean} True if a reorganization is detected, false otherwise
     */
    async detectReorg(currentBlockHash) {
        try {
            const storedBlockHash = await db.get('lastKnownBlock');
            if (storedBlockHash !== currentBlockHash) {
                console.log('Reorganization detected');
                return true;
            }
            return false;
        } catch (error) {
            if (error.type === 'NotFoundError') {
                console.log('No last known block found');
                return false;
            } else {
                console.error('Error detecting reorganization:', error);
                return false;
            }
        }
    }

    /**
     * Handles a detected reorganization by reverting to the last checkpoint.
     */
    async handleReorg() {
        // Load the last saved state from the checkpoint
        const state = await this.loadState();

        if (state) {
            // Revert system state to the last saved state
            console.log('Reverting to last known good state');
            // Additional logic to revert system state goes here

            // After reverting, resume processing from the last known good block
            // This might involve re-scanning blocks from the last known good block
            // to the current block, applying changes to the reverted state
        } else {
            console.error('No saved state available to revert to');
            // Handle the situation when no checkpoint is available
        }
    }

    /**
     * Loads the saved state from a checkpoint.
     * This is a placeholder and needs implementation based on how state is saved.
     */
    async loadState() {
        // Placeholder implementation
        try {
            const state = await db.get('savedState');
            return state;
        } catch (error) {
            console.error('Error loading state:', error);
            return null;
        }
    }

    async getActivationsSnapshot() {
        const snapshot = {};
        try {
            // Retrieve all data from the activations sublevel
            for await (const [key, value] of activationsDB.createReadStream()) {
                // Process and store each key-value pair in the snapshot
                // Depending on your data structure, you might need to parse the value or perform other transformations
                snapshot[key] = value;
            }
        } catch (error) {
            console.error('Error fetching activations snapshot:', error);
            throw error; // Rethrow the error to handle it in the calling function
        }
        return snapshot;
    }

    async getTallyMapSnapshot() {
        // Logic to get snapshot of tallyMap
    }

    async getPropertyListSnapshot() {
        // Logic to get snapshot of propertyList
    }

    async getWhitelistsSnapshot() {
        // Logic to get snapshot of whitelists
    }

    async getOraclesSnapshot() {
        // Logic to get snapshot of oracles
    }

    async getContractListSnapshot() {
        // Logic to get snapshot of contract list
    }

    async getMarginMapsSnapshot() {
        // Logic to get snapshot of marginMaps
    }

    async saveState() {
        try {
            const state = {
                activations: await this.getActivationsSnapshot(),
                tallyMap: await this.getTallyMapSnapshot(),
                propertyList: await this.getPropertyListSnapshot(),
                whitelists: await this.getWhitelistsSnapshot(),
                oracles: await this.getOraclesSnapshot(),
                contractList: await this.getContractListSnapshot(),
                marginMaps: await this.getMarginMapsSnapshot()
            };

            await persistenceDB.put('savedState', JSON.stringify(state));
            console.log('State saved successfully');
        } catch (error) {
            console.error('Error saving state:', error);
        }
    }

    /**
     * Loads the blockchain state from the most recent checkpoint.
     */
    async loadStateFromCheckpoint() {
        // Load and deserialize the state from the DB
        // Placeholder implementation
        // Consider using JSON.parse or a similar method for deserialization
    }

    /**
     * Manages and maintains checkpoints.
     */
    manageCheckpoints() {
        // Logic to create new checkpoints and prune old ones
    }
}

module.exports = BlockchainPersistence;
