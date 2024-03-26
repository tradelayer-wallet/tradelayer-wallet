

const litecoin = require('litecoin');

// Configure your Litecoin client connection
const clientConfig = {
    host: '127.0.0.1',
    port: 18332, // Testnet port; use 9332 for Mainnet
    user: 'user',
    pass: 'pass',
    timeout: 30000
};

const client = new litecoin.Client(clientConfig);

// Function to dump the private key
function dumpPrivKey(address) {
    client.cmd('dumpprivkey', address, function(err, privateKey, resHeaders) {
        if (err) {
            console.error('Error dumping private key:', err);
            return;
        }
        console.log(`Private key for address ${address}: ${privateKey}`);
    });
}

// Replace with the address you want to get the private key for
const address = 'LNmiS6p8z3KuHHx3q6Jf6x6TfcyptE68oP';
dumpPrivKey(address);
