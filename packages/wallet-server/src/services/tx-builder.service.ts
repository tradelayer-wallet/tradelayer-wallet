import { fasitfyServer } from "..";
import axios from 'axios';
import { RpcClient } from 'tl-rpc';
import { buildPsbt, signRawTransction } from "../utils/crypto.util";
import { safeNumber } from "../utils/common.util";

// let usedUTXOS: string[] = [];
interface ApiRes {
    data: any;
    error: string;
}

const networkMap = {
   BTC: {
    messagePrefix: '\x18Bitcoin Signed Message:\n',
    bech32: 'bc',
    bip32: {
      public: 0x0488b21e,
      private: 0x0488ade4,
    },
    pubKeyHash: 0x00,
    scriptHash: 0x05,
    wif: 0x80,
  },

  // -----------------------------
  // BITCOIN TESTNET / SIGNET
  // -----------------------------
  BTCTEST: {
    messagePrefix: '\x18Bitcoin Signed Message:\n',
    bech32: 'tb',
    bip32: {
      public: 0x043587cf,
      private: 0x04358394,
    },
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    wif: 0xef,
  },
  LTC: {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bip32: {
      public: 0x019da462,
      private: 0x019d9cfe,
    },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0,
    bech32: 'ltc', // Add this
  },
  LTCTEST: {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bip32: {
      public: 0x043587cf,
      private: 0x04358394,
    },
    pubKeyHash: 0x6f,
    scriptHash: 0x3a,
    wif: 0xef,
    bech32: 'tltc', // Add this
  },
};


export type TClient = (method: string, ...args: any[]) => Promise<ApiRes>;

let directRpcClient: RpcClient | null = null;

export interface IBuildTxConfig {
    fromKeyPair: {
        address: string;
        pubkey?: string;
    };
    toKeyPair: {
        address: string;
        pubkey?: string;
    };
    amount?: number;
    payload?: string;
    inputs?: IInput[];
    addPsbt?: boolean;
    network?: string;
};

export interface IBuildLTCITTxConfig {
    buyerKeyPair: {
        address: string;
        pubkey?: string;
    };
    sellerKeyPair: {
        address: string;
        pubkey?: string;
    };
    amount: number;
    payload: string;
    commitUTXOs: IInput[],
    network: string;
}

export interface ISignTxConfig {
    rawtx: string;
    wif: string;
    network: string;
    inputs: IInput[];
    psbtHex?: string;
};

export interface ISignPsbtConfig {
    wif: string;
    network: string;
    psbtHex: string;
};

export interface IBitvmDlcOutputTarget {
    address: string;
    amount: number | string;
    label?: string;
}

export interface IBitvmDlcMultiOutputTxConfig {
    fromAddress: string;
    outputs: IBitvmDlcOutputTarget[];
    payload?: string;
    addPsbt?: boolean;
    network: string;
    minConfirmations?: number;
}

const minFeeLtcPerKb = 0.00015;

export interface IInput {
    txid: string;
    amount: number;
    confirmations: number;
    scriptPubKey: string;
    vout: number;
    redeemScript?: string;
    pubkey?: string;
};

// native/multisig.ts (Node environment)
import * as bitcoin from 'bitcoinjs-lib';

export async function computeMultisigNative(
  m: number,
  pubKeys: string[],
  network: string
) {
  const net = networkMap[network];
  if (!net) throw new Error(`Unknown network: ${network}`);
  if (!Array.isArray(pubKeys) || pubKeys.length < m) throw new Error('Invalid pubKeys');

  // ✅ BIP67 canonicalization here
  const pubBufs = pubKeys
    .map(k => Buffer.from(k, 'hex'))
    .sort(Buffer.compare);

  const p2ms = bitcoin.payments.p2ms({ m, pubkeys: pubBufs });
  if (!p2ms.output) throw new Error('Failed to build witness script');

  const p2wsh = bitcoin.payments.p2wsh({
    redeem: { output: p2ms.output },
    network: net,
  });

  if (!p2wsh.address || !p2wsh.output) throw new Error('Failed to compute p2wsh');

  return {
    m,
    pubKeys: pubBufs.map(b => b.toString('hex')), // canonical pubkeys
    redeemScript: p2ms.output.toString('hex'),
    scriptPubKey: p2wsh.output.toString('hex'),
    address: p2wsh.address,
  };
}



export const smartRpc: TClient = async (method: string, params: any[] = [], api: boolean = false) => {
    if (fasitfyServer.rpcClient && !api) {
        return await fasitfyServer.rpcClient.call(method, ...params);;
    }

    if (fasitfyServer.relayerApiUrl) {
        const url = `${fasitfyServer.relayerApiUrl}/rpc/${method}`;
        return await axios.post(url, { params })
            .then(res => res.data);
    }

    if (!directRpcClient) {
        directRpcClient = new RpcClient({
            username: process.env.LTC_RPC_USER || process.env.RPC_USER || 'user',
            password: process.env.LTC_RPC_PASS || process.env.RPC_PASSWORD || 'pass',
            host: process.env.LTC_RPC_HOST || '127.0.0.1',
            port: Number(process.env.LTC_RPC_PORT || process.env.RPC_PORT || 19332) || 19332,
            timeout: 20000,
        });
    }

    return await directRpcClient.call(method, ...params);
};

export const jsTlApi: TClient = async (method: string, params: any[] = []) => {
    const url = `http://localhost:3000/${method}`;
    return await axios.post(url, { params })
        .then(res => res.data);
};

const createRawTransactionWithOptionalPayload = async (
    inputs: { txid: string; vout: number }[],
    outputs: Record<string, number>,
    payload: string | undefined,
    isApiMode: boolean
) => {
    if (!payload) {
        return smartRpc('createrawtransaction', [inputs, outputs], isApiMode);
    }

    const rpcOutputs: Array<Record<string, number | string>> =
        Object.entries(outputs).map(([address, amount]) => ({ [address]: amount }));
    rpcOutputs.push({ data: Buffer.from(payload, 'utf8').toString('hex') });
    return smartRpc('createrawtransaction', [inputs, rpcOutputs], isApiMode);
};

const addOutputAmount = (outputs: Record<string, number>, address: string, amount: number) => {
    outputs[address] = safeNumber((outputs[address] || 0) + amount);
};

export const buildLTCInstatTx = async (txConfig: IBuildLTCITTxConfig, isApiMode: boolean) => {
    try {
        const { buyerKeyPair, sellerKeyPair, amount, payload, commitUTXOs, network } = txConfig;
        console.log('tx config in build LTC insta'+JSON.stringify(txConfig))
        const buyerAddress = buyerKeyPair.address;
        const sellerAddress = sellerKeyPair.address;
        const vaRes1 = await smartRpc('validateaddress', [buyerAddress], isApiMode);
        if (vaRes1.error || !vaRes1.data?.isvalid) throw new Error(`validateaddress: ${vaRes1.error}`);
        const vaRes2 = await smartRpc('validateaddress', [sellerAddress], isApiMode);
        if (vaRes2.error || !vaRes2.data?.isvalid) throw new Error(`validateaddress: ${vaRes2.error}`);
    
        const luRes = await smartRpc('listunspent', [0, 999999999, [buyerAddress]], false);
        if (luRes.error || !luRes.data) return new Error(`listunspent: ${luRes.error}`);
        const _utxos = (luRes.data as IInput[])
            .map(i => ({ ...i, pubkey: buyerKeyPair.pubkey }))
            .sort((a, b) => b.amount - a.amount)
            // .filter(u => !usedUTXOS.includes(u.txid));
        const utxos = [...commitUTXOs, ..._utxos];
        const minAmountRes = await getMinVoutAmount(sellerAddress, isApiMode);
        if (minAmountRes.error || !minAmountRes.data) return new Error(`getMinVoutAmount: ${minAmountRes.error}`);
        const minAmount = minAmountRes.data;
        const buyerLtcAmount = minAmount;
        const sellerLtcAmount = Math.max(amount, minAmount);
        const minAmountForAllOuts = safeNumber(buyerLtcAmount + sellerLtcAmount);
        const inputsRes = getEnoughInputs2(utxos, minAmountForAllOuts);
        const { finalInputs, fee } = inputsRes;
        const _inputsSum = finalInputs.map(({amount}) => amount).reduce((a, b) => a + b, 0);
        const inputsSum = safeNumber(_inputsSum);
        const changeBuyerLtcAmount = safeNumber(inputsSum - sellerLtcAmount - fee) > buyerLtcAmount
            ? safeNumber(inputsSum - sellerLtcAmount - fee)
            : buyerLtcAmount;
        if (inputsSum < safeNumber(fee + sellerLtcAmount + changeBuyerLtcAmount)) throw new Error("Not Enough coins for paying fees. Code 1");
        if (!finalInputs.length) throw new Error("Not Enough coins for paying fees. Code 3");
        const _insForRawTx = finalInputs.map(({txid, vout }) => ({ txid, vout }));
        const _outsForRawTx: Record<string, number> = {};
        addOutputAmount(_outsForRawTx, buyerAddress, changeBuyerLtcAmount);
        addOutputAmount(_outsForRawTx, sellerAddress, sellerLtcAmount);
        console.log('inputs and outputs in ltc trade builder '+JSON.stringify(_insForRawTx)+' '+JSON.stringify(_outsForRawTx))
        const crtRes = await createRawTransactionWithOptionalPayload(_insForRawTx, _outsForRawTx, payload, isApiMode);
        if (crtRes.error || !crtRes.data) throw new Error(`createrawtransaction: ${crtRes.error}`);
        const finalTx = crtRes.data;
        const psbtHexConfig = {
            rawtx: finalTx,
            inputs: finalInputs,
            network: network,
        };
        const psbtHexRes = buildPsbt(psbtHexConfig);
        if (psbtHexRes.error || !psbtHexRes.data) throw new Error(`buildPsbt: ${psbtHexRes.error}`);
        const data: any = { rawtx: finalTx, inputs: finalInputs, psbtHex: psbtHexRes.data };
        return { data };
    } catch (error) {
        return { error: error.message || 'Undefined build Tx Error' };
    }
};

export const buildTx = async (txConfig: IBuildTxConfig, isApiMode: boolean) => {
    try {
        const { fromKeyPair, toKeyPair, amount, payload, inputs, addPsbt, network } = txConfig;
        const fromAddress = fromKeyPair.address;
        const toAddress = toKeyPair.address;
        console.log('validate address 1 '+fromAddress)
        const vaRes1 = await smartRpc('validateaddress', [fromAddress], isApiMode);
        if (vaRes1.error || !vaRes1.data?.isvalid) throw new Error(`validateaddress: ${vaRes1.error}`);
        console.log('validate address 2 '+toAddress)
        const vaRes2 = await smartRpc('validateaddress', [toAddress], isApiMode);
        if (vaRes2.error || !vaRes2.data?.isvalid) throw new Error(`validateaddress: ${vaRes2.error}`);
        console.log('About to call listunspent in buildTx '+ fromAddress)
        const luRes = await smartRpc('listunspent', [0, 999999999, [fromAddress]], isApiMode);
        console.log(JSON.stringify(luRes))
        if (luRes.error || !luRes.data) return new Error(`listunspent: ${luRes.error}`);
        const _utxos = (luRes.data as IInput[])
            .map(i => ({...i, pubkey: fromKeyPair.pubkey}))
            .sort((a, b) => b.amount - a.amount);
        const _inputs = inputs?.length ? inputs : [];
        const utxos = [..._inputs, ..._utxos];
        const minAmountRes = await getMinVoutAmount(toAddress, isApiMode);
        if (minAmountRes.error || !minAmountRes.data) throw new Error(`getMinVoutAmount: ${minAmountRes.error}`);
        const minAmount = minAmountRes.data;
        if (minAmount > amount && !payload) throw new Error(`Minimum amount is: ${minAmount}`);

        const _amount = Math.max(amount || 0, minAmount);
        const estimateFee = (inputCount: number) => safeNumber((0.2 * minFeeLtcPerKb) * inputCount);
        const selectInputs = (targetAmount: number) => {
            const finalInputs: IInput[] = [];
            for (const u of utxos) {
                finalInputs.push(u);
                const _inputsSum = finalInputs.map(({ amount }) => amount).reduce((a, b) => a + b, 0);
                const inputsSum = safeNumber(_inputsSum);
                const fee = estimateFee(finalInputs.length);
                if (inputsSum >= safeNumber(targetAmount + fee)) {
                    break;
                }
            }
            const fee = estimateFee(finalInputs.length);
            return { finalInputs, fee };
        };
        const { finalInputs, fee } = selectInputs(_amount);
        const _inputsSum = finalInputs.map(({amount}) => amount).reduce((a, b) => a + b, 0);
        const inputsSum = safeNumber(_inputsSum);
        const toAmount = _amount;
        const dustThreshold = minAmount;
        let change = safeNumber(inputsSum - toAmount - fee);
        if (change > 0 && change < dustThreshold) {
            // Fold dust into the fee instead of emitting an invalid change output.
            change = 0;
        }

        if (inputsSum < safeNumber(toAmount + fee)) throw new Error("Not Enaugh coins for paying fees. Code 1");
        if (inputsSum < _amount) throw new Error("Not Enaugh coins for paying fees. Code 2");
        if (!finalInputs.length) throw new Error("Not Enaugh coins for paying fees. Code 3");
        if (change < 0) throw new Error("Not Enaugh coins for paying fees. Code 4");

        const _insForRawTx = finalInputs.map(({txid, vout }) => ({ txid, vout }));
        const _outsForRawTx: Record<string, number> = {};
        addOutputAmount(_outsForRawTx, toAddress, toAmount);
        if (change > 0) addOutputAmount(_outsForRawTx, fromAddress, change);
        const crtRes = await createRawTransactionWithOptionalPayload(_insForRawTx, _outsForRawTx, payload, isApiMode);
        if (crtRes.error || !crtRes.data) throw new Error(`createrawtransaction: ${crtRes.error}`);
        const finalTx = crtRes.data;
        const data: any = { rawtx: finalTx, inputs: finalInputs };
        if (addPsbt) {
            const psbtHexConfig = {
                rawtx: finalTx,
                inputs: finalInputs,
                network: network,
            }
            const psbtHexRes = buildPsbt(psbtHexConfig);
            if (psbtHexRes.error || !psbtHexRes.data) throw new Error(`buildPsbt: ${psbtHexRes.error}`);
            data.psbtHex = psbtHexRes.data;
        }
        return { data };
    } catch (error) {
        return { error: error.message || 'Undefined build Tx Error' };
    }
}

const getEnoughInputs2 = (_inputs: IInput[], amount: number) => {
    const finalInputs: IInput[] = [];
    _inputs.forEach(u => {
        const _amountSum: number = finalInputs.map(r => r.amount).reduce((a, b) => a + b, 0);
        const amountSum = safeNumber(_amountSum);
        const _fee = safeNumber((0.2 * minFeeLtcPerKb) * (finalInputs.length + 1));
        if (amountSum < safeNumber(amount + _fee)) finalInputs.push(u);
    });
    const fee = safeNumber((0.2 * minFeeLtcPerKb) * finalInputs.length);
    return { finalInputs, fee };
};

const getEnoughInputs = (_inputs: IInput[], amount: number) => {
    const finalInputs: IInput[] = [];
    _inputs.forEach(u => {
        const _amountSum: number = finalInputs.map(r => r.amount).reduce((a, b) => a + b, 0);
        const amountSum = safeNumber(_amountSum);
        if (amountSum < amount) finalInputs.push(u);
    });
    const fee = safeNumber((0.2 * minFeeLtcPerKb) * finalInputs.length);
    return { finalInputs, fee };
};

const getMinVoutAmount = async (toAddress: string, isApiMode: boolean) => {
    try {
        return { data: 0.0000546 };
        const crtxrRes = await smartRpc('tl_createrawtx_reference', ['', toAddress], isApiMode);
        if (crtxrRes.error || !crtxrRes.data) throw new Error(`tl_createrawtx_reference: ${crtxrRes.error}`);
        const drwRes = await smartRpc('decoderawtransaction', [crtxrRes.data], isApiMode);
        if (drwRes.error || !drwRes.data) throw new Error(`decoderawtransaction: ${drwRes.error}`);
        const minAmount = parseFloat(drwRes.data.vout[0].value);
        // if (minAmount !== 0.000036) throw new Error(`min Amount is not 0.000036`);
        return { data: minAmount };
    } catch (error) {
        return { error: error.message || 'Undefined getMinVoutAmount Error' };
    }
}

const buildMultiOutputTx = async (txConfig: IBitvmDlcMultiOutputTxConfig, isApiMode: boolean) => {
    try {
        const fromAddress = String(txConfig.fromAddress || '').trim();
        if (!fromAddress) throw new Error('Missing fromAddress');

        const vaRes1 = await smartRpc('validateaddress', [fromAddress], isApiMode);
        if (vaRes1.error || !vaRes1.data?.isvalid) throw new Error(`validateaddress: ${vaRes1.error}`);

        const minConfirmations = Number.isFinite(Number(txConfig.minConfirmations))
            ? Math.max(0, Math.floor(Number(txConfig.minConfirmations)))
            : 1;
        const luRes = await smartRpc('listunspent', [minConfirmations, 999999999, [fromAddress]], isApiMode);
        if (luRes.error || !luRes.data) return { error: `listunspent: ${luRes.error}` };

        const normalizedOutputs = (txConfig.outputs || [])
            .map((o) => ({
                address: String(o.address || '').trim(),
                amount: safeNumber(Number(o.amount || 0)),
                label: String(o.label || ''),
            }))
            .filter((o) => o.address && o.amount > 0);

        if (!normalizedOutputs.length) {
            throw new Error('No outputs provided for multi-output tx');
        }

        const dustThreshold = 0.0000546;
        const mergedOutputs = new Map<string, number>();
        let dustCarry = 0;
        for (const out of normalizedOutputs) {
            if (out.amount < dustThreshold) {
                dustCarry = safeNumber(dustCarry + out.amount);
                continue;
            }
            mergedOutputs.set(out.address, safeNumber((mergedOutputs.get(out.address) || 0) + out.amount));
        }
        if (dustCarry > 0) {
            const firstAddr = mergedOutputs.keys().next().value;
            if (firstAddr) {
                mergedOutputs.set(firstAddr, safeNumber((mergedOutputs.get(firstAddr) || 0) + dustCarry));
            } else {
                throw new Error('All outputs were dust after normalization');
            }
        }

        const _utxos = (luRes.data as IInput[])
            .map(i => ({ ...i, pubkey: i.pubkey }))
            .sort((a, b) => b.amount - a.amount);

        const targetOut = Array.from(mergedOutputs.values()).reduce((sum, amt) => safeNumber(sum + amt), 0);
        const estimateFee = (inputCount: number, outputCount: number) => safeNumber((0.2 * minFeeLtcPerKb) * (inputCount + outputCount));
        const selectInputs = (targetAmount: number) => {
            const finalInputs: IInput[] = [];
            for (const u of _utxos) {
                finalInputs.push(u);
                const inputsSum = safeNumber(finalInputs.map(({ amount }) => amount).reduce((a, b) => a + b, 0));
                const fee = estimateFee(finalInputs.length, mergedOutputs.size + 1);
                if (inputsSum >= safeNumber(targetAmount + fee)) {
                    break;
                }
            }
            const fee = estimateFee(finalInputs.length, mergedOutputs.size + 1);
            return { finalInputs, fee };
        };

        const { finalInputs, fee } = selectInputs(targetOut);
        const inputsSum = safeNumber(finalInputs.map(({ amount }) => amount).reduce((a, b) => a + b, 0));
        const change = safeNumber(inputsSum - targetOut - fee);
        let normalizedChange = change;
        if (normalizedChange > 0 && normalizedChange < dustThreshold) {
            const firstAddr = mergedOutputs.keys().next().value;
            if (firstAddr) {
                mergedOutputs.set(firstAddr, safeNumber((mergedOutputs.get(firstAddr) || 0) + normalizedChange));
            }
            normalizedChange = 0;
        }

        if (inputsSum < safeNumber(targetOut + fee)) throw new Error('Not Enaugh coins for paying fees. Code 1');
        if (!finalInputs.length) throw new Error('Not Enaugh coins for paying fees. Code 3');

        const _insForRawTx = finalInputs.map(({ txid, vout }) => ({ txid, vout }));
        const _outsForRawTx: Record<string, number> = {};
        Array.from(mergedOutputs.entries()).forEach(([addr, amt]) => {
            _outsForRawTx[addr] = safeNumber((_outsForRawTx[addr] || 0) + amt);
        });
        if (normalizedChange > 0) {
            _outsForRawTx[fromAddress] = safeNumber((_outsForRawTx[fromAddress] || 0) + normalizedChange);
        }

        const crtRes = await createRawTransactionWithOptionalPayload(_insForRawTx, _outsForRawTx, txConfig.payload, isApiMode);
        if (crtRes.error || !crtRes.data) throw new Error(`createrawtransaction: ${crtRes.error}`);
        const finalTx = crtRes.data;

        const data: any = { rawtx: finalTx, inputs: finalInputs, outputs: _outsForRawTx };
        if (txConfig.addPsbt) {
            const psbtHexConfig = {
                rawtx: finalTx,
                inputs: finalInputs,
                network: txConfig.network,
            };
            const psbtHexRes = buildPsbt(psbtHexConfig);
            if (psbtHexRes.error || !psbtHexRes.data) throw new Error(`buildPsbt: ${psbtHexRes.error}`);
            data.psbtHex = psbtHexRes.data;
        }
        return { data };
    } catch (error: any) {
        return { error: error.message || 'Undefined multi-output tx Error' };
    }
};

export const signTx = async (signOptions: ISignTxConfig) => {
    try {
        const { rawtx, wif, network, inputs } = signOptions;
        const lastResult = signRawTransction({ rawtx, wif, network, inputs });
        // if (lastResult.data) {
        //     inputs.map(e => {
        //         usedUTXOS.push(e.txid);
        //         setTimeout(() => usedUTXOS = usedUTXOS.filter(q => q !== e.txid), 10000);
        //     });
        // }
        return lastResult;
    } catch (error) {
        return { error: error.message };
    }
};

export const buildBitvmDlcFundingTx = async (txConfig: IBitvmDlcMultiOutputTxConfig, isApiMode: boolean) => {
    return buildMultiOutputTx(txConfig, isApiMode);
};

export const buildBitvmDlcRouteSpendTx = async (txConfig: IBitvmDlcMultiOutputTxConfig, isApiMode: boolean) => {
    return buildMultiOutputTx(txConfig, isApiMode);
};
