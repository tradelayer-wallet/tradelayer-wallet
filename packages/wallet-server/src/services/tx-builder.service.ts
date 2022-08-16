import { fasitfyServer } from "..";
import axios from 'axios';
import { signRawTransction } from "../utils/crypto.util";
export interface IBuildTxConfig {
    fromAddress: string;
    toAddress: string;
    amount?: number;
    payload?: string;
};

export interface ISignTxConfig {
    rawtx: string;
    wif: string;
    network: string;
    inputs: IInput[];
};

export interface IInput {
    txid: string;
    amount: number;
    confirmations: number;
    redeemScript: string;
    vout: number;
};

const minFeeLtcPerKb = 0.002;

const safeNumber = (a: number, d: number = 8) => parseFloat((a).toFixed(d));

export const smartRpc = async (method: string, params: any[] = [], api: boolean = false) => {
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

export const buildTx = async (txConfig: IBuildTxConfig, isApiMode: boolean) => {
    try {
        const { fromAddress, toAddress, amount, payload } = txConfig;
        const vaRes1 = await smartRpc('validateaddress', [fromAddress], isApiMode);
        if (vaRes1.error || !vaRes1.data?.isvalid) throw new Error(`validateaddress: ${vaRes1.error}`);
        const vaRes2 = await smartRpc('validateaddress', [toAddress], isApiMode);
        if (vaRes2.error || !vaRes2.data?.isvalid) throw new Error(`validateaddress: ${vaRes2.error}`);

        const luRes = await smartRpc('listunspent', [0, 999999999, [fromAddress]], true);
        if (luRes.error || !luRes.data) throw new Error(`listunspent: ${luRes.error}`);

        const utxos = (luRes.data as IInput[]).sort((a, b) => b.amount - a.amount);
        const inputsRes = getEnoughInputs(utxos, amount);
        const { inputs, fee } = inputsRes;
        const inputsSum = inputs.map(({amount}) => amount).reduce((a, b) => a + b, 0);

        const minAmountRes = await getMinVoutAmount(toAddress, isApiMode);
        if (minAmountRes.error || !minAmountRes.data) throw new Error(`getMinVoutAmount: ${minAmountRes.error}`);
        const minAmount = minAmountRes.data;

        const _toAmount = safeNumber(amount - fee);
        const toAmount = _toAmount > minAmount ? _toAmount : minAmount;
        const change = safeNumber(inputsSum - amount);

        if (inputsSum < (fee + toAmount + change)) throw new Error("Not Enaugh coins for paying fees. Code 1");
        if (inputsSum < amount) throw new Error("Not Enaugh coins for paying fees. Code 2");
        if (!inputs.length) throw new Error("Not Enaugh coins for paying fees. Code 3");

        const _insForRawTx = inputs.map(({txid, vout }) => ({ txid, vout }));
        const _outsForRawTx = { [toAddress]: toAmount };
        if (change > 0) _outsForRawTx[fromAddress] = change;
        const crtRes = await smartRpc('createrawtransaction', [_insForRawTx, _outsForRawTx], isApiMode);
        if (crtRes.error || !crtRes.data) throw new Error(`createrawtransaction: ${crtRes.error}`);
        let finalTx = crtRes.data;
        if (payload) {
            const crtxoprRes = await smartRpc('tl_createrawtx_opreturn', [payload], isApiMode);
            if (crtxoprRes.error || !crtxoprRes.data) throw new Error(`tl_createrawtx_opreturn: ${crtxoprRes.error}`);
            finalTx = crtxoprRes.data;
        }
        return { rawtx: finalTx, inputs };
    } catch (error) {
        return { error: error.message || 'Undefined build Tx Error' };
    }
}

const getEnoughInputs = (_inputs: IInput[], amount: number) => {
    const inputs: IInput[] = [];
    _inputs.forEach(u => {
        const _amountSum: number = inputs.map(r => r.amount).reduce((a, b) => a + b, 0);
        const amountSum = safeNumber(_amountSum);
        if (amountSum < amount) inputs.push(u);
    });
    const fee = safeNumber((0.3 * minFeeLtcPerKb) * inputs.length);
    return { inputs, fee };
};

const getMinVoutAmount = async (toAddress: string, isApiMode: boolean) => {
    try {
        const crtxrRes = await smartRpc('tl_createrawtx_reference', ['', toAddress], isApiMode);
        if (crtxrRes.error || !crtxrRes.data) throw new Error(`tl_createrawtx_reference: ${crtxrRes.error}`);
        const drwRes = await smartRpc('decoderawtransaction', [crtxrRes.data], isApiMode);
        if (drwRes.error || !drwRes.data) throw new Error(`decoderawtransaction: ${drwRes.error}`);
        const minAmount = parseFloat(drwRes.data.vout[0].value);
        return { data: minAmount };
    } catch (error) {
        return { error: error.message || 'Undefined getMinVoutAmount Error' };
    }
}

export const signTx = async (signOptions: ISignTxConfig) => {
    try {
        const { rawtx, wif, network, inputs } = signOptions;
        const lastResult = signRawTransction({ rawtx, wif, network, inputs });
        return { data: lastResult };
    } catch (error) {
        return { error: error.message };
    }
};
