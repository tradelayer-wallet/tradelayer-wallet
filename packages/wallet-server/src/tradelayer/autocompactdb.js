const dbInstance = require('./path/to/your/dbInstance'); // Import your database instance
const COMPACT_INTERVAL_MS = 60000; // Set this to your desired compaction interval in milliseconds
const COMPACT_MODULO = 10; // Perform compaction every 10th interval

let intervalCount = 0;

setInterval(() => {
    intervalCount++;
    if (intervalCount % COMPACT_MODULO === 0) {
        console.log('Compacting database...');
        compactDatabase();
    }
}, COMPACT_INTERVAL_MS);

function compactDatabase() {
    // Assuming you have multiple databases to compact, loop through them
    const databases = ['tallyMap', 'propertyList', 'anotherDatabase']; // List your databases here
    databases.forEach(dbName => {
        const db = dbInstance.getDatabase(dbName);
        db.persistence.compactDatafile();
        console.log(`Compacted ${dbName} database.`);
    });
}
