const dbInstance = require('./db');

// Load tallyMapDelta database
const tallyMapDeltaDB = dbInstance.getDatabase('tallyMapDelta');

// Function to tally amounts and calculate balance for each type and property ID
async function calculateBalanceForAddress(address) {
    try {
        // Find all delta records for the given address
        const deltaRecords = await tallyMapDeltaDB.findAsync({ 'data.address': address });

        // Create a map to store totals for each type, property ID, and cumulative amounts
        const totalsByTypeAndProperty = {};

        // Iterate through delta records and tally totals for each type, property ID, and cumulative amounts
        deltaRecords.forEach(delta => {
            const { type, property, avail, res, mar, vest } = delta.data;

            // Update totals
            totalsByTypeAndProperty[type] = totalsByTypeAndProperty[type] || {};
            totalsByTypeAndProperty[type][property] = totalsByTypeAndProperty[type][property] || {
                count: 0,
                cumulativeAmounts: { avail: 0, res: 0, mar: 0, vest: 0 }
            };
            
            // Increment count
            totalsByTypeAndProperty[type][property].count++;

            // Update cumulative amounts
            totalsByTypeAndProperty[type][property].cumulativeAmounts.avail += avail || 0;
            totalsByTypeAndProperty[type][property].cumulativeAmounts.res += res || 0;
            totalsByTypeAndProperty[type][property].cumulativeAmounts.mar += mar || 0;
            totalsByTypeAndProperty[type][property].cumulativeAmounts.vest += vest || 0;
        });

        // Display totals by type, property ID, and cumulative amounts
        console.log(`Totals by type, property ID, and cumulative amounts for address ${address}:`);
        Object.entries(totalsByTypeAndProperty).forEach(([type, propertyTotals]) => {
            console.log(`Type: ${type}`);
            Object.entries(propertyTotals).forEach(([property, { count, cumulativeAmounts }]) => {
                console.log(`  Property ID ${property} - Count: ${count}`);
                console.log(`    Avail: ${cumulativeAmounts.avail}`);
                console.log(`    Res: ${cumulativeAmounts.res}`);
                console.log(`    Mar: ${cumulativeAmounts.mar}`);
                console.log(`    Vest: ${cumulativeAmounts.vest}`);
            });
        });

        return totalsByTypeAndProperty;
    } catch (error) {
        console.error('Error calculating balance:', error);
        throw error;
    }
}

// Example: Replace 'your_address_here' with the actual address you want to calculate the balance for
const addressToCalculate = 'tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8';

// Call the function to calculate and display the totals by type, property ID, and cumulative amounts
calculateBalanceForAddress(addressToCalculate);
