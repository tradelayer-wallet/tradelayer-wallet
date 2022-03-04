import SocketScript from "../socket-script";
import { RawTx } from "../socket-script/common/rawtx";
import { IBuildRawTxOptions } from "../socket-script/common/types";
import axios from 'axios';

export const buildAndSend = async (socketScript: SocketScript, method: string, params: any) => {
    const { asyncClient } = socketScript;

    const isTestnet = false;
    const url = isTestnet
        ? 'http://ec2-13-40-194-140.eu-west-2.compute.amazonaws.com:9191/rpc/'
        : 'http://170.187.147.182:9191/rpc/';

    const address = params[0];
    const utxosRes = await axios({
        method: 'POST',
        url: url + 'listunspent',
        data: { params: [1, 999999999, [address]] },
    });
    if (utxosRes.data?.error || !utxosRes.data?.data) return { error: 'Error with getting UTXOs. Code: 1' };
    if (!utxosRes.data?.data?.length) return { error: 'Not available balance.' };
    const inputs = utxosRes.data.data;
    if (method === 'tl_send') {
        const fromAddress = params[0];
        const toAddress = params[1];
        const propId = params[2];
        const amount = params[3];
        
        const tlcpssRes = await asyncClient('tl_createpayload_simplesend', propId, amount);
        if (tlcpssRes.error || !tlcpssRes.data) return { error: 'Error with creating Simple Send Payload' };
        
        const options: IBuildRawTxOptions = {
            fromAddress,
            toAddress,
            payload: tlcpssRes.data,
            inputs: inputs,
        };

        const rawTx = new RawTx(options, asyncClient);
        const build = await rawTx.build();
        if (build.error || !build.data) return { error: build.error || 'Error with Building the transacion!' };
        const signed = await rawTx.signRawTx(true);
        if (signed.error || !signed.data) return { error: signed.error || 'Error with Signing the transacion!' };
        
        const sendrawtxRes = await axios({
            method: 'POST',
            url: url + 'sendrawtransaction',
            data: { params: [signed.data] },
        });

        if (sendrawtxRes.data?.error || !sendrawtxRes.data?.data) {
            return { error: sendrawtxRes.data?.error || 'Error with Sending Transaction!' };
        }

        return sendrawtxRes.data;
    }

    if (method === 'sendtoaddress') {
        const fromAddress = params[0];
        const toAddress = params[1];
        const amount = params[2];
        const options: IBuildRawTxOptions = {
            fromAddress,
            toAddress,
            inputs: inputs,
            refAddressAmount: parseFloat(amount),
        };
        const rawTx = new RawTx(options, asyncClient);
        const build = await rawTx.build();
        if (build.error || !build.data) return { error: build.error || 'Error with Building the transacion!' };
        const signed = await rawTx.signRawTx(true);
        if (signed.error || !signed.data) return { error: signed.error || 'Error with Signing the transacion!' };

        const sendrawtxRes = await axios({
            method: 'POST',
            url: url + 'sendrawtransaction',
            data: { params: [signed.data] },
        });

        if (sendrawtxRes.data?.error || !sendrawtxRes.data?.data) {
            return { error: sendrawtxRes.data?.error || 'Error with Sending Transaction!' };
        }

        return sendrawtxRes.data;
    }

    if (method === 'tl_attestation') {
        const fromAddress = params[0];
        const toAddress = params[1];
        const tlcpssRes = await asyncClient('tl_createpayload_attestation');
        if (tlcpssRes.error || !tlcpssRes.data) return { error: 'Error with creating Simple Send Payload' };

        const options: IBuildRawTxOptions = {
            fromAddress,
            toAddress,
            payload: tlcpssRes.data,
            inputs: inputs,
        };

        const rawTx = new RawTx(options, asyncClient);
        const build = await rawTx.build();
        if (build.error || !build.data) return { error: build.error || 'Error with Building the transacion!' };
        const signed = await rawTx.signRawTx(true);
        if (signed.error || !signed.data) return { error: signed.error || 'Error with Signing the transacion!' };
        
        const sendrawtxRes = await axios({
            method: 'POST',
            url: url + 'sendrawtransaction',
            data: { params: [signed.data] },
        });

        if (sendrawtxRes.data?.error || !sendrawtxRes.data?.data) {
            return { error: sendrawtxRes.data?.error || 'Error with Sending Transaction!' };
        }

        return sendrawtxRes.data;
    }

    return { error: `Something Goes Wrong` };
};

// tl_attestation
// tl_send
// tl_commit_tochannel