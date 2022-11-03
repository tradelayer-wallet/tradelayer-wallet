import { fasitfyServer } from "..";
import axios from 'axios';
import { buildPsbt, signRawTransction } from "../utils/crypto.util";
import { safeNumber } from "../utils/common.util";

// let usedUTXOS: string[] = [];
interface ApiRes {
    data: any;
    error: string;
}

export type TClient = (method: string, ...args: any[]) => Promise<ApiRes>;

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

export interface IInput {
    txid: string;
    amount: number;
    confirmations: number;
    scriptPubKey: string;
    vout: number;
    redeemScript?: string;
    pubkey?: string;
};

const minFeeLtcPerKb = 0.002;


export const smartRpc: TClient = async (method: string, params: any[] = [], api: boolean = false) => {
    if (fasitfyServer.rpcClient && !api) {
        return await fasitfyServer.rpcClient.call(method, ...params);;
    } else {
        if (fasitfyServer.relayerApiUrl) {
            const url = `${fasitfyServer.relayerApiUrl}/rpc/${method}`;
            return await axios.post(url, { params })
                .then(res => res.data);
        } else {
            return { error: `Relayer API url not found` };
        }
    }
};

export const buildLTCInstatTx = async (txConfig: IBuildLTCITTxConfig, isApiMode: boolean) => {
    try {
        const { buyerKeyPair, sellerKeyPair, amount, payload, commitUTXOs, network } = txConfig;
        const buyerAddress = buyerKeyPair.address;
        const sellerAddress = sellerKeyPair.address;
        const vaRes1 = await smartRpc('validateaddress', [buyerAddress], isApiMode);
        if (vaRes1.error || !vaRes1.data?.isvalid) throw new Error(`validateaddress: ${vaRes1.error}`);
        const vaRes2 = await smartRpc('validateaddress', [sellerAddress], isApiMode);
        if (vaRes2.error || !vaRes2.data?.isvalid) throw new Error(`validateaddress: ${vaRes2.error}`);
    
        const luRes = await smartRpc('listunspent', [0, 999999999, [buyerAddress]], true);
        if (luRes.error || !luRes.data) throw new Error(`listunspent: ${luRes.error}`);
        const _utxos = (luRes.data as IInput[])
            .map(i => ({ ...i, pubkey: buyerKeyPair.pubkey }))
            .sort((a, b) => b.amount - a.amount)
            // .filter(u => !usedUTXOS.includes(u.txid));
        const utxos = [...commitUTXOs, ..._utxos];
        const minAmountRes = await getMinVoutAmount(sellerAddress, isApiMode);
        if (minAmountRes.error || !minAmountRes.data) throw new Error(`getMinVoutAmount: ${minAmountRes.error}`);
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
        if (inputsSum < safeNumber(fee + sellerLtcAmount + changeBuyerLtcAmount)) throw new Error("Not Enaugh coins for paying fees. Code 1");
        if (!finalInputs.length) throw new Error("Not Enaugh coins for paying fees. Code 3");
        const _insForRawTx = finalInputs.map(({txid, vout }) => ({ txid, vout }));
        const _outsForRawTx = { [buyerAddress]: changeBuyerLtcAmount, [sellerAddress]: sellerLtcAmount };

        const crtRes = await smartRpc('createrawtransaction', [_insForRawTx, _outsForRawTx], isApiMode);
        if (crtRes.error || !crtRes.data) throw new Error(`createrawtransaction: ${crtRes.error}`);
        const crtxoprRes = await smartRpc('tl_createrawtx_opreturn', [crtRes.data, payload], isApiMode);
        if (crtxoprRes.error || !crtxoprRes.data) throw new Error(`tl_createrawtx_opreturn: ${crtxoprRes.error}`);
        const finalTx = crtxoprRes.data;
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
        const vaRes1 = await smartRpc('validateaddress', [fromAddress], isApiMode);
        if (vaRes1.error || !vaRes1.data?.isvalid) throw new Error(`validateaddress: ${vaRes1.error}`);
        const vaRes2 = await smartRpc('validateaddress', [toAddress], isApiMode);
        if (vaRes2.error || !vaRes2.data?.isvalid) throw new Error(`validateaddress: ${vaRes2.error}`);

        const luRes = await smartRpc('listunspent', [0, 999999999, [fromAddress]], true);
        if (luRes.error || !luRes.data) throw new Error(`listunspent: ${luRes.error}`);
        const _utxos = (luRes.data as IInput[])
            .map(i => ({...i, pubkey: fromKeyPair.pubkey}))
            .sort((a, b) => b.amount - a.amount);
        const _inputs = inputs?.length ? inputs : [];
        const utxos = [..._inputs, ..._utxos];
        const minAmountRes = await getMinVoutAmount(toAddress, isApiMode);
        if (minAmountRes.error || !minAmountRes.data) throw new Error(`getMinVoutAmount: ${minAmountRes.error}`);
        const minAmount = minAmountRes.data;
        if (minAmount > amount && !payload) throw new Error(`Minimum amount is: ${minAmount}`);

        const _amount = Math.max(amount || 0, minAmount)
        const inputsRes = getEnoughInputs(utxos, _amount);
        const { finalInputs, fee } = inputsRes;
        const _inputsSum = finalInputs.map(({amount}) => amount).reduce((a, b) => a + b, 0);
        const inputsSum = safeNumber(_inputsSum);

        const _toAmount = safeNumber(_amount - fee);
        const toAmount = Math.max(minAmount, _toAmount)
        const change = !payload 
            ? safeNumber(inputsSum - _amount)
            : safeNumber(inputsSum - _amount - fee);

        if (inputsSum < safeNumber(fee + toAmount + change)) throw new Error("Not Enaugh coins for paying fees. Code 1");
        if (inputsSum < _amount) throw new Error("Not Enaugh coins for paying fees. Code 2");
        if (!finalInputs.length) throw new Error("Not Enaugh coins for paying fees. Code 3");

        const _insForRawTx = finalInputs.map(({txid, vout }) => ({ txid, vout }));
        const _outsForRawTx = { [toAddress]: toAmount };
        if (change > 0) _outsForRawTx[fromAddress] = change;
        const crtRes = await smartRpc('createrawtransaction', [_insForRawTx, _outsForRawTx], isApiMode);
        if (crtRes.error || !crtRes.data) throw new Error(`createrawtransaction: ${crtRes.error}`);
        let finalTx = crtRes.data;
        if (payload) {
            const crtxoprRes = await smartRpc('tl_createrawtx_opreturn', [finalTx, payload], isApiMode);
            if (crtxoprRes.error || !crtxoprRes.data) throw new Error(`tl_createrawtx_opreturn: ${crtxoprRes.error}`);
            finalTx = crtxoprRes.data;
        }
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
        const _fee = safeNumber((0.3 * minFeeLtcPerKb) * (finalInputs.length + 1));
        if (amountSum < safeNumber(amount + _fee)) finalInputs.push(u);
    });
    const fee = safeNumber((0.3 * minFeeLtcPerKb) * finalInputs.length);
    return { finalInputs, fee };
};

const getEnoughInputs = (_inputs: IInput[], amount: number) => {
    const finalInputs: IInput[] = [];
    _inputs.forEach(u => {
        const _amountSum: number = finalInputs.map(r => r.amount).reduce((a, b) => a + b, 0);
        const amountSum = safeNumber(_amountSum);
        if (amountSum < amount) finalInputs.push(u);
    });
    const fee = safeNumber((0.3 * minFeeLtcPerKb) * finalInputs.length);
    return { finalInputs, fee };
};

const getMinVoutAmount = async (toAddress: string, isApiMode: boolean) => {
    try {
        const crtxrRes = await smartRpc('tl_createrawtx_reference', ['', toAddress], isApiMode);
        if (crtxrRes.error || !crtxrRes.data) throw new Error(`tl_createrawtx_reference: ${crtxrRes.error}`);
        const drwRes = await smartRpc('decoderawtransaction', [crtxrRes.data], isApiMode);
        if (drwRes.error || !drwRes.data) throw new Error(`decoderawtransaction: ${drwRes.error}`);
        const minAmount = parseFloat(drwRes.data.vout[0].value);
        if (minAmount !== 0.000036) throw new Error(`min Amount is not 0.000036`);
        return { data: minAmount };
    } catch (error) {
        return { error: error.message || 'Undefined getMinVoutAmount Error' };
    }
}

export const signTx = async (signOptions: ISignTxConfig) => {
    try {
        const { rawtx, wif, network, inputs, psbtHex } = signOptions;
        const lastResult = signRawTransction({ rawtx, wif, network, inputs, psbtHex });
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
