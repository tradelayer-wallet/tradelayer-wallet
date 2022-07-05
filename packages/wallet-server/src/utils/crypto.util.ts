import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { payments } from 'bitcoinjs-lib';
import { dPaths, networks } from './networks';

const bip32 = BIP32Factory(ecc);
const { p2wpkh, p2sh } = payments;


export type TNetwork = 'LTC' | 'BTC'| 'LTCTEST'| 'BTCTEST';

export const generateNewWallet = (networkString: TNetwork) => {
    const network = networks[networkString];
    if (!network) return { error: 'Network not found!'};
    const mnemonic = generateMnemonic();
    return { mnemonic };
};

export const getKeyPair = (
        networkString: TNetwork,
        mnemonic: string,
        derivatePath?: string,
        isFullPath: boolean = false,
    ) => {
    const network = networks[networkString];
    if (!network) return { error: 'Network not found!'};
    const seed = mnemonicToSeedSync(mnemonic);
    const main = bip32.fromSeed(seed, network);
    const initPath = dPaths[networkString]
    const fullPath = isFullPath ? derivatePath : initPath + derivatePath;
    const child = main.derivePath(fullPath);
    const redeem = p2wpkh({ pubkey: child.publicKey, network });
    const { address } = p2sh({ redeem });
    const privkey = child.privateKey.toString('hex');
    const pubkey = child.publicKey.toString('hex');
    const wif = child.toWIF();
    return { address, privkey, pubkey, wif };
};

export const getManyKeyPair = (networkString: TNetwork, mnemonic: string, walletObjRaw: any) => {
    const network = networks[networkString];
    if (!network) return { error: 'Network not found!'};

    const allKeys = Object.keys(walletObjRaw);
    const finalObj: any = {};
    allKeys.forEach(k => {
        finalObj[k] = [];
        const keys: string[] = walletObjRaw[k];
        keys.forEach(path => {
            const keyPair = getKeyPair(networkString, mnemonic, path, true);
            finalObj[k].push(keyPair);
        });
    });
    return finalObj;
}
