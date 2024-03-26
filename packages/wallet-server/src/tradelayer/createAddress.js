const litecoin = require('litecoin');

const client = new litecoin.Client({
    host: '127.0.0.1',
    port: 18332, // Use 9332 for mainnet
    user: 'user', // Replace with actual RPC username
    pass: 'pass', // Replace with actual RPC password
    timeout: 30000
});

async function createAndImportAddress() {
    try {
        // Create a new address
        const newAddress = await new Promise((resolve, reject) => {
            client.getNewAddress('', (error, address) => {
                if (error) reject(error);
                else resolve(address);
            });
        });

        console.log(`New address created: ${newAddress}`);

        // Dump the private key for the new address
        const privateKey = await new Promise((resolve, reject) => {
            client.dumpPrivKey(newAddress, (error, key) => {
                if (error) reject(error);
                else resolve(key);
            });
        });

        console.log(`Private key for new address: ${privateKey}`);

        // Import the private key back into the wallet (optional, as it should already be in the wallet)
        await new Promise((resolve, reject) => {
            client.importPrivKey(privateKey, '', false, (error, result) => {
                if (error) reject(error);
                else resolve(result);
            });
        });

        console.log('Private key imported successfully into the wallet.');

    } catch (error) {
        console.error('Error during address creation and import:', error);
    }
}

createAndImportAddress();
