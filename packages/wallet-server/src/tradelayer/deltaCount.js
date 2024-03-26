const dbInstance = require('./db');

// Load tallyMapDelta database
const tallyMapDeltaDB = dbInstance.getDatabase('tallyMapDelta');

// Function to tally amounts and calculate balance for each type
async function calculateBalanceForAddress(address) {
    try {
        // Find all delta records for the given address
        const deltaRecords = await tallyMapDeltaDB.findAsync({ 'data.address': address });

        // Create a map to store counts for each type
        const typeCounts = {};

        // Iterate through delta records and tally counts for each type
        deltaRecords.forEach(delta => {
            const { type } = delta.data;

            // Update type count
            typeCounts[type] = (typeCounts[type] || 0) + 1;
        });

        // Sort type counts by type
        const sortedTypeCounts = Object.entries(typeCounts).sort((a, b) => {
            const typeA = a[0].toUpperCase(); // ignore case
            const typeB = b[0].toUpperCase();
            return typeA.localeCompare(typeB);
        });

        // Display sorted type counts
        console.log(`Type counts for address ${address}:`);
        sortedTypeCounts.forEach(([type, count]) => {
            console.log(`${type}: ${count}`);
        });

        return sortedTypeCounts;
    } catch (error) {
        console.error('Error calculating balance:', error);
        throw error;
    }
}

// Example: Replace 'your_address_here' with the actual address you want to calculate the balance for
const addressToCalculate = 'tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8';

// Call the function to calculate and display the type counts
calculateBalanceForAddress(addressToCalculate);
