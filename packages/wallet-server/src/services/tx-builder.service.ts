import { fasitfyServer } from "..";
import axios from 'axios';
import { signRawTransction } from "../utils/crypto.util";
import { safeNumber } from "../utils/common.util";

interface ApiRes {
    data: any;
    error: string;
}

export type TClient = (method: string, ...args: any[]) => Promise<ApiRes>;

export interface IBuildTxConfig {
    fromAddress: string;
    toAddress: string;
    amount?: number;
    payload?: string;
    inputs?: IInput[];
};

export interface ISignTxConfig {
    rawtx: string;
    wif: string;
    network: string;
    inputs: IInput[];
    halfSignedHex: string;
};

export interface IInput {
    txid: string;
    amount: number;
    confirmations: number;
    scriptPubKey: string;
    vout: number;
    redeemScript?: string;
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

export const buildTx = async (txConfig: IBuildTxConfig, isApiMode: boolean) => {
    try {
        const { fromAddress, toAddress, amount, payload, inputs } = txConfig;
        const vaRes1 = await smartRpc('validateaddress', [fromAddress], isApiMode);
        if (vaRes1.error || !vaRes1.data?.isvalid) throw new Error(`validateaddress: ${vaRes1.error}`);
        const vaRes2 = await smartRpc('validateaddress', [toAddress], isApiMode);
        if (vaRes2.error || !vaRes2.data?.isvalid) throw new Error(`validateaddress: ${vaRes2.error}`);

        const luRes = await smartRpc('listunspent', [0, 999999999, [fromAddress]], true);
        if (luRes.error || !luRes.data) throw new Error(`listunspent: ${luRes.error}`);
        const _utxos = (luRes.data as IInput[]).sort((a, b) => b.amount - a.amount);
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
        return { data: { rawtx: finalTx, inputs: finalInputs } };
    } catch (error) {
        return { error: error.message || 'Undefined build Tx Error' };
    }
}

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
        return { data: minAmount };
    } catch (error) {
        return { error: error.message || 'Undefined getMinVoutAmount Error' };
    }
}

export const signTx = async (signOptions: ISignTxConfig) => {
    try {
        const { rawtx, wif, network, inputs, halfSignedHex } = signOptions;
        const lastResult = signRawTransction({ rawtx, wif, network, inputs, halfSignedHex });
        return lastResult;
    } catch (error) {
        return { error: error.message };
    }
};
