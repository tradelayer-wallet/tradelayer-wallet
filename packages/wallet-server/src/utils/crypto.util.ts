import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
import { BIP32Factory } from 'bip32';
import { payments, Psbt, Transaction } from 'bitcoinjs-lib';
import { networks } from './networks';
import { ECPairFactory } from 'ecpair';
import { IInput } from '../services/tx-builder.service';
import * as ecc from 'tiny-secp256k1';
import { toSats } from './common.util';

const ECPair = ECPairFactory(ecc);
const bip32 = BIP32Factory(ecc);
const { p2wpkh, p2sh, p2ms, p2wsh } = payments;

export type TNetwork = 'LTC' | 'BTC'| 'LTCTEST'| 'BTCTEST';

// The one place a network name becomes network parameters. An unknown name, including an inherited
// property name such as "constructor", is refused. It is never replaced by a default network.
const networkOf = (name: string) => {
    if (!Object.prototype.hasOwnProperty.call(networks, name)) throw new Error('Network not found!');
    return networks[name as TNetwork];
};

export const generateNewWallet = (networkString: TNetwork) => {
    networkOf(networkString);
    const mnemonic = generateMnemonic();
    return { mnemonic };
};

export const getKeyPair = (
        networkString: TNetwork,
        mnemonic: string,
        derivatePath?: string,
    ) => {
    const network = networkOf(networkString);
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
    networkOf(networkString);

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


export const signPsbtRawtTx = (signOptions: {
    wif: string;
    network: string;
    psbtHex: string;
}) => {
    try {
        const { wif, network, psbtHex } = signOptions;
        const _network = networkOf(network);
        const keyPair = ECPair.fromWIF(wif, _network);
        const psbt = Psbt.fromHex(psbtHex);
        // The sighash type of each input comes from the PSBT, which a counterparty
        // supplies. Only SIGHASH_ALL is ever signed: an input that asks for NONE or
        // SINGLE (with or without ANYONECANPAY) is left unsigned, so it cannot be used
        // to authorize a different transaction.
        psbt.signAllInputs(keyPair, [Transaction.SIGHASH_ALL]);
        const newPsbtHex = psbt.toHex();
        try {
            psbt.finalizeAllInputs();
            const finalHex = psbt.extractTransaction().toHex();
            return { data: { psbtHex: newPsbtHex, isFinished: true, finalHex } };
        } catch (err) {
            return { data: { psbtHex: newPsbtHex, isFinished: false } };
        }
    } catch (error) {
        return { error: error.message };
    }
};

export const signRawTransction = (signOptions: {
    rawtx: string;
    wif: string;
    network: string;
    inputs: IInput[];
}) => {
    try {
        const { rawtx, wif, inputs, network } = signOptions;
        const _network = networkOf(network);
        const keyPair = ECPair.fromWIF(wif, _network);
        const redeemObj = p2wpkh({ pubkey: keyPair.publicKey, network: _network });
        const redeemScript = redeemObj.output;

        const tx = Transaction.fromHex(rawtx);
        const exatractScript = (redeemScript: string) => {
            const p2msObj = p2ms({ output: Buffer.from(redeemScript, 'hex'), network: _network});
            const p2wshObj = p2wsh({ redeem: p2msObj })
            return p2wshObj.output;
        };
        const psbt: Psbt = new Psbt({ network: _network });
        inputs.forEach((e) => {
            const hash = e.txid;
            const index = e.vout;
            const value = toSats(e.amount);
            const script = e.redeemScript ? exatractScript(e.redeemScript) : redeemScript;
            const witnessUtxo = { script, value };
            const inputObj: any = { hash, index, witnessUtxo };
            if (e.redeemScript) inputObj.witnessScript = Buffer.from(e.redeemScript, 'hex');
            e.redeemScript
                ? inputObj.redeemScript = exatractScript(e.redeemScript)
                : inputObj.redeemScript = redeemScript;
            psbt.addInput(inputObj);
        });
        psbt.addOutputs(tx.outs);
        psbt.signAllInputs(keyPair);
        const isValid = psbt.validateSignaturesOfAllInputs(validator);
        try {
            psbt.finalizeAllInputs();
            const signedHex = psbt.extractTransaction().toHex();
            return { data: { signedHex, isValid, isFinished: true } };
        } catch (err) {
            const signedHex = psbt.toHex();
            return { data: { signedHex, isValid, isFinished: false } };
        }

    } catch (error) {
        return { error: error.message };
    }
};

export const buildPsbt = (buildPsbtOptions: { rawtx: string, inputs: IInput[], network: string }) => {
    try {
        const { rawtx, inputs, network } = buildPsbtOptions;
        const _network = networkOf(network);

        const tx = Transaction.fromHex(rawtx);
        const psbt: Psbt = new Psbt({ network: _network });

        const getScript = (input: any) => {
            const payment = input.redeemScript
                ? p2wsh({ redeem: p2ms({ output: Buffer.from(input.redeemScript, 'hex'), network: _network}) })
                : input.pubkey
                    ? p2wpkh({ pubkey: Buffer.from(input.pubkey, 'hex'), network: _network })
                    : null;
            return payment ? payment.output : null;
        };

        inputs.forEach((input: any) => {
            const hash = input.txid;
            const index = input.vout;
            const value = toSats(input.amount);
            const script = getScript(input);
            const witnessUtxo = { script, value };
            const inputObj: any = { hash, index, witnessUtxo };
            if (script) inputObj.redeemScript = script
            if (input.redeemScript) inputObj.witnessScript = Buffer.from(input.redeemScript, 'hex');
            psbt.addInput(inputObj);
        });
        psbt.addOutputs(tx.outs);
        const psbtHex = psbt.toHex();
        return { data: psbtHex};
    } catch (error) {
        return { error: error.message };   
    }
}