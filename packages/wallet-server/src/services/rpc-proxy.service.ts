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
