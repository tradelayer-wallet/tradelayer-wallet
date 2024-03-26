const db = require('./db.js');
const path = require('path');

class InsuranceFund {
    constructor(contractSeriesId, balance, hedgeRatio) {
        this.contractSeriesId = contractSeriesId;
        this.balances = []; //{propertyId: '',amountAvailable:0,amountVesting:0}
        this.hedgeRatio = 0.5; // 50/50 hedging with the contract
        // Additional properties for hedging strategy
    }

    async deposit(propertyId, amount, vesting) {
        let propertyFound = false;

        for (const balance of this.balances) {
            if (balance.propertyId === propertyId) {
                if (vesting) {
                    balance.amountVesting += amount;
                } else {
                    balance.amountAvailable += amount;
                }
                propertyFound = true;
                break; // Exit loop after updating the existing propertyId
            }
        }

        // If the propertyId was not found in the array, add a new entry
        if (!propertyFound) {
            const newBalance = {
                propertyId: propertyId,
                amountAvailable: vesting ? 0 : amount,
                amountVesting: vesting ? amount : 0
            };
            this.balances.push(newBalance);
        }

        await this.saveSnapshot();
        // Additional logic for hedging strategy (if any)
    }

    async withdraw(amount) {
        if (amount > this.balance) {
            throw new Error("Insufficient balance in the insurance fund");
        }
        this.balance -= amount;
        await this.saveSnapshot();
        // Adjust hedging strategy if needed
    }

    async handleDeficit(deficitAmount) {
        // Logic to manage the deficit
        // Record the deficit handling event
        await this.recordEvent('deficit', { amount: deficitAmount });
        // Adjust hedging strategy if needed
    }

    async saveSnapshot() {
        const snapshot = {
            balances: this.balances,
            contractSeriesId: this.contractSeriesId, // Use a colon here
            hedgeRatio: this.hedgeRatio, // Use a colon here
            timestamp: new Date().toISOString()
        };
        await new Promise((resolve, reject) => {
            db.getDatabase('insurance').insert({ key: `snapshot-${snapshot.timestamp}`, value: snapshot }, (err) => {
                if (err) reject(err);
                resolve();
            });
        });
    }


    async getSnapshot(timestamp) {
        return new Promise((resolve, reject) => {
            db.getDatabase('insurance').findOne({ key: `snapshot-${timestamp}` }, (err, doc) => {
                if (err) {
                    console.error('Error retrieving snapshot:', err);
                    reject(err);
                } else {
                    resolve(doc ? doc.value : null);
                }
            });
        });
    }

    async recordEvent(eventType, eventData) {
        const eventRecord = {
            type: eventType,
            data: eventData,
            timestamp: new Date().toISOString()
        };
        await new Promise((resolve, reject) => {
            db.getDatabase('insurance').insert({ key: `event-${eventRecord.timestamp}`, value: eventRecord }, (err) => {
                if (err) reject(err);
                resolve();
            });
        });
    }

    async getPayouts(contractId, startBlock, endBlock) {
        // ... Remaining code unchanged ...
    }

    async calcPayout(totalLoss){

    }

    // ... Rest of your class methods ...
}

module.exports = InsuranceFund;
