const Litecoin = require('litecoin');
const Bitcoin = require('bitcoin')

const createLitecoinClient = (test = true) => {
    const config = {
        host: '127.0.0.1',
        port: test ? 19332 : 9332,  // Switch between testnet and mainnet
        user: 'user',               // Make sure to replace these with your actual credentials
        pass: 'pass',
        timeout: 10000
    };

    return new Litecoin.Client(config);
};

const createBitcoinClient = (test = true) => {
    const config = {
        host: '127.0.0.1',
        port: test ? 18332 : 8332,  // Switch between testnet and mainnet
        user: 'user',               // Make sure to replace these with your actual credentials
        pass: 'pass',
        timeout: 10000
    };

    return new Bitcoin.Client(config);
};


module.exports = {createLitecoinClient, createBitcoinClient};
