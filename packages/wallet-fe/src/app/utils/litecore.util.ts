// import * as btc from 'bitcoinjs-lib';
import { IKeyPair } from '../@core/services/address.service';
import { AES, enc } from 'crypto-js';
// const tLTC = {
//     messagePrefix: '\x19Litecoin Signed Message:\n',
//     bip32: { public: 0x043587cf, private: 0x04358394 },
//     pubKeyHash: 0x6f,
//     scriptHash: 0xc4,
//     wif: 0xef,
//     bech32: 'ltc1',
//   }

// export const generateRandomAddress = () => {
//     const keyPair = btc.ECPair.makeRandom({ network: tLTC });
//     const { address } = btc.payments.p2pkh({ pubkey: keyPair.publicKey, network: tLTC });
//     const wifKey = keyPair.toWIF();
//     const pubKey = keyPair.publicKey
//     return { address, wifKey, pubKey };
// };

export const encryptKeyPair = (keypair: IKeyPair[], pass: string) => {
    const message = JSON.stringify(keypair);
    return AES.encrypt(message, pass).toString();
}

export const decryptKeyPair = (key: string, pass: string) => {
    try {
        const decrypted = AES.decrypt(key, pass);
        const dStr = decrypted.toString(enc.Utf8);
        return JSON.parse(dStr);
    } catch(err) {
        return null;
    }
}

// export const getPubKey = (wifKey: string) => {
//     const hm = btc.ECPair.fromWIF(wifKey, tLTC);
//     return ''
// }

export default {
    // generateRandomAddress,
    encryptKeyPair,
    decryptKeyPair,
};