import axios from 'axios';
import { fasitfyServer } from '../index';
import { callRpcFromDatadir, createRpcClientFromDatadir } from './node.service';

const DEFAULT_LISTENER_URL = 'http://127.0.0.1:3000';

const WALLET_RPC_METHODS = new Set([
    'createwallet',
    'loadwallet',
    'listwallets',
    'getwalletinfo',
    'getaddressesbylabel',
    'getnewaddress',
    'getrawchangeaddress',
    'getbalances',
    'getbalance',
    'getunconfirmedbalance',
    'getreceivedbylabel',
    'dumpprivkey',
    'importaddress',
    'importpubkey',
    'importmulti',
    'setlabel',
    'listlabels',
    'getaddressinfo',
    'listunspent',
    'signrawtransactionwithwallet',
    'walletpassphrase',
    'walletlock',
    'encryptwallet',
    'walletcreatefundedpsbt',
    'walletprocesspsbt',
    'backupwallet',
    'dumpwallet',
    'bumpfee',
]);

function getListenerUrl() {
    return String(process.env.TL_WALLET_LISTENER_URL || DEFAULT_LISTENER_URL).replace(/\/+$/, '');
}

function getWalletName(body: any) {
    return String(body?.walletName || body?.walletLabel || process.env.RPC_WALLET_NAME || process.env.WALLET_LABEL || '').trim();
}

function isWalletRpcMethod(method: string) {
    return WALLET_RPC_METHODS.has(String(method || '').trim().toLowerCase());
}

function isTransientRpcStartupError(error: any) {
    const msg = String(error?.message || error || '').toLowerCase();
    return error?.code === 'ECONNREFUSED'
        || error?.code === 'ETIMEDOUT'
        || error?.code === -28
        || msg.includes('econnrefused')
        || msg.includes('connect econnrefused')
        || msg.includes('connection refused')
        || msg.includes('socket hang up')
        || msg.includes('etimedout')
        || msg.includes('loading block index')
        || msg.includes('rewinding blocks')
        || msg.includes('warming up');
}

function encodeBase36(value: any, fallback = '0') {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n).toString(36) : fallback;
}

function encodeAmount(value: any) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return Math.round(n * 1e8).toString(36);
}

function encodeInteger(value: any) {
    if (value === undefined || value === null || value === '') return '0';
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n).toString(36) : '0';
}

function encodeBoolean(value: any) {
    return value === true || value === 1 || value === '1' ? '1' : '0';
}

function normalizeParams(body: any): any[] {
    return Array.isArray(body?.params)
        ? body.params
        : Array.isArray(body)
            ? body
            : [];
}

function buildTradeLayerPayload(method: string, body: any) {
    const normalized = method.toLowerCase();
    const params = normalizeParams(body);
    const source = params.length === 1 && typeof params[0] === 'object'
        ? params[0]
        : body || {};

    if (normalized === 'tl_createpayload_attestation') {
        const attestation = params.length >= 4
            ? { revoke: params[0], id: params[1], targetAddress: params[2], metaData: params[3] }
            : body || {};
        return [
            'tl9',
            attestation.revoke ?? 0,
            encodeBase36(attestation.id),
            attestation.targetAddress || '',
            attestation.metaData || '',
        ].join(',');
    }

    if (normalized === 'tl_createpayload_commit_tochannel') {
        const channelAddress = String(source.channelAddress || '');
        const clearLists = Array.isArray(source.clearLists)
            ? `[${source.clearLists.map((item: any) => encodeBase36(item)).join(',')}]`
            : source.clearLists
                ? encodeBase36(source.clearLists)
                : '';
        const payload = [
            encodeBase36(source.propertyId),
            encodeAmount(source.amount),
            channelAddress.length > 42 ? `ref:${source.ref || 0}` : channelAddress,
            source.payEnabled ? '1' : '0',
            clearLists,
            source.isColoredOutput ? '1' : '0',
        ];
        if (Number.isInteger(source.commitClearlistId)) {
            payload.push(source.commitClearlistId.toString(36));
        }
        return `tl4${payload.join(',')}`;
    }

    if (normalized === 'tl_createpayload_withdrawal_fromchannel') {
        return `tll${[
            encodeInteger(source.propertyId ?? source.propertyid),
            encodeAmount(source.amount),
            source.channelAddress || source.address || '',
            encodeBoolean(source.isColoredOutput),
        ].join(',')}`;
    }

    if (normalized === 'tl_createpayload_simplesend') {
        if (source.sendAll) {
            return `tl21;${source.address || source.toAddress || ''}`;
        }
        return `tl2${[
            '0',
            source.address || source.toAddress || '',
            encodeInteger(source.propertyId ?? source.propertyid),
            encodeAmount(source.amount),
        ].join(';')}`;
    }

    if (normalized === 'tl_createpayload_instant_trade' || normalized === 'tl_createpayload_instant_ltc_trade') {
        return `tl3${[
            encodeInteger(source.propertyId ?? source.propertyIdForSale ?? source.propertyIdOffered),
            encodeAmount(source.amount ?? source.amountForSale ?? source.amountOffered),
            source.columnA ?? source.column ?? '',
            encodeAmount(source.satsExpected ?? source.amountDesired ?? source.expectedSats),
            source.tokenOutput ?? source.output ?? '',
            source.payToAddress ?? source.toAddress ?? '',
            encodeBoolean(source.isColoredOutput),
        ].join(',')}`;
    }

    if (normalized === 'tl_createpayload_contract_instant_trade') {
        return `tli${[
            encodeInteger(source.contractId),
            encodeAmount(source.price),
            encodeInteger(source.amount),
            encodeBoolean(source.sell),
            encodeBoolean(source.insurance),
            encodeBoolean(source.reduce),
            encodeBoolean(source.post),
            encodeBoolean(source.stop),
        ].join(',')}`;
    }

    return null;
}

async function ensureRpcClient() {
    if (!fasitfyServer.rpcClient) {
        const rpcClient = createRpcClientFromDatadir(process.env.DATADIR, Number(process.env.RPC_PORT));
        if (rpcClient) {
            try {
                const probe = await rpcClient.call('getblockchaininfo');
                if (probe?.data && !probe?.error) {
                    fasitfyServer.rpcClient = rpcClient;
                    fasitfyServer.rpcPort = Number(process.env.RPC_PORT) || 19332;
                } else if (isTransientRpcStartupError(probe?.error)) {
                    throw new Error(String(probe?.error || 'Starting Litecoin daemon...'));
                }
            } catch (error: any) {
                if (isTransientRpcStartupError(error)) {
                    throw new Error(String(error?.message || error || 'Starting Litecoin daemon...'));
                }
                throw error;
            }
        }
    }

    if (!fasitfyServer.rpcClient) {
        throw new Error('No RPC Client initialized');
    }

    return fasitfyServer.rpcClient;
}

export async function proxyWalletMethod(method: string, body: any = {}) {
    const normalizedMethod = String(method || '').trim();
    if (!normalizedMethod) {
        throw new Error('Missing RPC method');
    }

    if (normalizedMethod.startsWith('tl_')) {
        const localPayload = buildTradeLayerPayload(normalizedMethod, body);
        if (localPayload !== null) {
            console.log('[rpc-proxy] local tl payload build', {
              method: normalizedMethod,
              paramsLength: Array.isArray(body?.params) ? body.params.length : undefined,
            });
            return localPayload;
        }

        const listenerUrl = getListenerUrl();
        console.log('[rpc-proxy] tl listener call', {
          method: normalizedMethod,
          listenerUrl,
          walletName: getWalletName(body) || '(default)',
          paramsLength: Array.isArray(body?.params) ? body.params.length : undefined,
        });
        const res = await axios.post(`${listenerUrl}/${normalizedMethod}`, body ?? {}, { timeout: 60000 });
        return res.data;
    }

    const walletName = getWalletName(body);
    if (walletName && isWalletRpcMethod(normalizedMethod)) {
        const datadir = process.env.DATADIR;
        const rpcPort = Number(process.env.RPC_PORT);
        console.log('[rpc-proxy] wallet rpc call', {
          method: normalizedMethod,
          walletName,
          datadir,
          rpcPort,
          paramsLength: Array.isArray(body?.params) ? body.params.length : undefined,
        });
        return await callRpcFromDatadir(datadir, rpcPort, normalizedMethod, Array.isArray(body?.params)
            ? body.params
            : Array.isArray(body)
                ? body
                : [], walletName);
    }

    const rpcClient = await ensureRpcClient();
    const params = Array.isArray(body?.params)
        ? body.params
        : Array.isArray(body)
            ? body
            : [];

    console.log('[rpc-proxy] core rpc call', {
      method: normalizedMethod,
      paramsLength: params.length,
    });

    return await rpcClient.call(normalizedMethod, ...params);
}
