import * as btc from 'bitcoinjs-lib';

const tLTC = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bip32: { public: 0x043587cf, private: 0x04358394 },
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    wif: 0xef,
    bech32: 'ltc1',
  }

export const generateRandomAddress = () => {
    const keyPair = btc.ECPair.makeRandom({ network: tLTC });
    const { address } = btc.payments.p2pkh({ pubkey: keyPair.publicKey, network: tLTC });
    const wifKey = keyPair.toWIF();
    return { address, wifKey };
};

export default {
    generateRandomAddress,
};