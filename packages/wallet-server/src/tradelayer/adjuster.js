class TickSizeAdjuster {
    constructor() {
        this.tickSize = 0.1; // Initial tick size
        this.minContractSize = 1; // Minimum contract size
        this.notionalThreshold = 2; // Threshold for increasing tick size
        this.notionalMultiplier = 10; // Multiplier for notional value increase
        this.doublingInterval = 3; // Doubling interval for tick size adjustment
        this.consecutiveDoublings = 0; // Counter for consecutive doublings
    }

    adjustTickSize(notionalValue) {
        if (notionalValue >= this.notionalThreshold * this.minContractSize) {
            this.consecutiveDoublings++;

            if (this.consecutiveDoublings >= this.doublingInterval) {
                // Double tick size every 'doublingInterval' consecutive doublings
                this.tickSize *= 2;
                this.consecutiveDoublings = 0;

                // Save adjustment event to the database
                this.saveAdjustmentEvent("DoubleTickSize", this.tickSize);
            }

            // Increase tick size based on notional value
            this.tickSize *= this.notionalMultiplier;

            // Save adjustment event to the database
            this.saveAdjustmentEvent("IncreaseTickSize", this.tickSize);
        } else {
            this.consecutiveDoublings = 0; // Reset consecutive doublings if notional value is below threshold
        }

        return this.tickSize;
    }

    increaseNotionalSize() {
        this.minContractSize *= 10;

        // Save adjustment event to the database
        this.saveAdjustmentEvent("IncreaseNotionalSize", this.minContractSize);
    }

    saveAdjustmentEvent(type, value) {
        return new Promise(async (resolve, reject) => {
            try {
                const db = require('./db.js');

                // Save adjustment event to the "contractAdjustments" category in the database
                const result = await db.getDatabase("contractAdjustments").updateAsync(
                    { category: "contractAdjustments" },
                    { $push: { events: { type, value, timestamp: new Date() } } },
                    { upsert: true }
                );

                resolve(result);
            } catch (error) {
                reject(error);
            }
        });
    }

}

// Example usage
const tickSizeAdjuster = new TickSizeAdjuster();

// Simulate trading with varying notional values
const notionalValues = [1, 5, 10, 20, 50, 100, 500, 1000];

notionalValues.forEach((notionalValue) => {
    const adjustedTickSize = tickSizeAdjuster.adjustTickSize(notionalValue);
    console.log(`Notional Value: ${notionalValue}, Adjusted Tick Size: ${adjustedTickSize}`);
});

// Simulate increasing notional size
tickSizeAdjuster.increaseNotionalSize();
console.log(`New Min Contract Size: ${tickSizeAdjuster.minContractSize}`);
