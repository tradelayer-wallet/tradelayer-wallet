const litecore = require('litecore-lib');

module.exports = {
  buildTx(commitUTXO, toAddress, payload) {
    const tx = new litecore.Transaction()
      .from(commitUTXO)
      .addOutput(new litecore.Transaction.Output({
        script: litecore.Script.buildDataOut(payload),
        satoshis: 0
      }))
      .to(toAddress, 1000); // Example value in satoshis
    return tx;
  },

  signTx(tx, keypair) {
    const privateKey = litecore.PrivateKey.fromWIF(keypair.wif);
    return tx.sign(privateKey);
  },

  signPsbt(keypair, psbtHex) {
    // Psbt signing logic
    return psbtHex; // Placeholder
  },

  sendTx(signedTx) {
    // Send tx logic using wallet listener
  }
};
