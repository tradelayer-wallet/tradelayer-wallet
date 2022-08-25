import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
import { BIP32Factory } from 'bip32';
import { payments, Psbt, Transaction } from 'bitcoinjs-lib';
import { networks } from './networks';
import { ECPairFactory } from 'ecpair';
import { IInput } from '../services/tx-builder.service';
import * as ecc from 'tiny-secp256k1';
import { safeNumber } from './common.util';

const ECPair = ECPairFactory(ecc);
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
    ) => {
    const network = networks[networkString];
    if (!network) return { error: 'Network not found!'};
    const seed = mnemonicToSeedSync(mnemonic);
    const main = bip32.fromSeed(seed, network);
    const child = main.derivePath(derivatePath);
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
            const keyPair = getKeyPair(networkString, mnemonic, path);
            finalObj[k].push(keyPair);
        });
    });
    return finalObj;
};

const validator = (pubkey: Buffer, msghash: Buffer, signature: Buffer) =>
    ECPair.fromPublicKey(pubkey).verify(msghash, signature);

export const signRawTransction = (signOptions: { 
    rawtx: string;
    wif: string;
    network: string;
    inputs: IInput[];
}) => {
    try {
        const { rawtx, wif, inputs, network } = signOptions;
        const _network = networks[network];

        const keyPair = ECPair.fromWIF(wif, _network);
        const redeemObj = p2wpkh({ pubkey: keyPair.publicKey, network: _network });
        const redeemScript = Buffer.from(redeemObj.output.toString('hex'), 'hex');

        const psbt = new Psbt({ network: _network });
        const tx = Transaction.fromHex(rawtx);

        inputs.forEach((e) => {
            const hash = e.txid;
            const index = e.vout;
            const value = safeNumber(e.amount * (10**8));
            const witnessUtxo = { script: redeemScript, value };
            psbt.addInput({ hash, index, redeemScript, witnessUtxo });
        });
        psbt.addOutputs(tx.outs);
        psbt.signAllInputs(keyPair);
        const isValid = psbt.validateSignaturesOfAllInputs(validator);
        psbt.finalizeAllInputs();
        const signedHex = psbt.extractTransaction().toHex();
        return { data: { signedHex, isValid } };
    } catch (error) {
        return { error: error.message };
    }
};
