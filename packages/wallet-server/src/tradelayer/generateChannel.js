const litecore = require('bitcore-lib-ltc');
const { TradeChannels } = require('./tradeChannels.js');

async function setupTradeChannel(privateKeyA, privateKeyB) {
    const tradeChannels = new TradeChannels();

    // Extract public keys from the private keys
    const publicKeyA = new litecore.PrivateKey(privateKeyA).toPublicKey();
    const publicKeyB = new litecore.PrivateKey(privateKeyB).toPublicKey();

    // Create multisig address from public keys
    const multisigAddress = new litecore.Address([publicKeyA, publicKeyB], 2).toString();

    // Create a new trade channel with the multisig address as the channel ID
    const tradeChannel = tradeChannels.createChannel(multisigAddress, 'addressA', 'addressB');

    // Commit transactions to the channel
    let commitTx1 = await commitTransaction('addressA', 'addressB', propertyId1, amount1, privateKeyA);
    let commitTx2 = await commitTransaction('addressB', 'addressA', propertyId2, amount2, privateKeyB);

    // Add commitments to the channel
    tradeChannel.addCommitment(commitTx1);
    tradeChannel.addCommitment(commitTx2);

    // Return the trade channel for further processing
    return tradeChannel;
}

// Example usage with test private keys
const privateKeyA = '...'; // Replace with private key for address A
const privateKeyB = '...'; // Replace with private key for address B
setupTradeChannel(privateKeyA, privateKeyB).then(tradeChannel => {
    console.log('Trade Channel Setup:', tradeChannel);
});
