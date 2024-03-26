const litecoin = require('litecoin');

const clientConfig = {
    host: '127.0.0.1',
    port: 18332,
    user: 'user', // Replace with your RPC username
    pass: 'pass', // Replace with your RPC password
    timeout: 10000
};

const client = new litecoin.Client(clientConfig);

// Function to import an address
function importAddress(address) {
    client.cmd('importaddress', address, '', false, function(err, response, resHeaders) {
        if (err) {
            console.error('Error importing address:', err);
            return;
        }
        console.log('Address imported successfully:', response);
    });
}

// Replace with the address you want to import
const addressToImport = "mj4iTwbHiQX6objWNXHjerF2KQDFcPCdUx";

// Execute the function
importAddress(addressToImport);
