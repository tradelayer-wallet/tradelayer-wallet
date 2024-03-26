const Datastore = require('nedb')
const path = require('path')
const util = require('util')

class Database {
    constructor(dbPath) {
        this.databases = {}

        // Define the categories for your datastores
        const categories = [
            'txIndex',
            'propertyList',
            'oracleList',
            'oracleData',
            'contractList',
            'tallyMap',
            'tallyMapDelta',
            'marginMapDelta',
            'marginMaps',
            'whitelists',
            'clearing',
            'consensus',
            'persistence',
            'volumeIndex',
            'channels',
            'withdrawQueue',
            'activations',
            'insurance',
            'orderBooks',
            'feeCache',
            'tradeHistory',
            'fundingEvents',
            'vaults',
            'syntheticTokens',
            'liquidations'
        ]

        // Initialize a NeDB datastore for each category and promisify methods
        categories.forEach(category => {
            const db = new Datastore({ 
                filename: path.join(dbPath, `${category}.db`), 
                autoload: true 
            })

            // Promisify NeDB methods for each category
            db.findAsync = util.promisify(db.find.bind(db))
            db.insertAsync = util.promisify(db.insert.bind(db))
            db.removeAsync = util.promisify(db.remove.bind(db))
            db.updateAsync = util.promisify(db.update.bind(db))
            db.findOneAsync = util.promisify(db.findOne.bind(db))
            db.countAsync = util.promisify(db.count.bind(db))

            this.databases[category] = db
        })

        
    }

    getDatabase(category) {
        return this.databases[category];
    }

    // You can keep the callback-based methods or replace them with promisified methods
    // Example: get, put, del, findAll

    // Additional methods like batch operations, find, etc., can be added as needed.
}

// Initialize the Database instance with the desired path
module.exports = new Database(path.join(__dirname, 'nedb-data'));