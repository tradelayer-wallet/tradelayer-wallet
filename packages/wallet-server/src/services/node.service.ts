import axios from "axios";
import { exec, execFileSync } from "child_process";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { tmpdir } from "os";
import { coreFilePathObj, defaultDirObj } from "../conf/windows.conf";
import { RpcClient } from 'tl-rpc';
import { fasitfyServer } from "..";
import { FastifyServer } from "../fastify-server";
import fastify from "fastify";
import { loadEnvIntoProcess } from '../utils/env.util';
loadEnvIntoProcess();

interface IRpcConnectionConfig {
    username: string;
    password: string;
    host: string;
    port: number;
    timeout: number;
}


interface IFlagsObject {
    testnet: number;
    txindex: number;
    startclean: number;
    reindex: number;
    addnode: string;
    datadir: string;
}

class FlagsObject implements IFlagsObject {
    public testnet: number = 0;
    public txindex: number = 0;
    public startclean: number = 0;
    public reindex: number = 0;
    public addnode: string = null;
    public datadir: string = null;
    public connect: string = null;
    constructor(options: any) {
        const toBool = (param: boolean) => param ? 1 : 0;

        this.testnet = toBool(!!options.testnet);
        this.txindex = toBool(!!options.txindex);
        this.startclean = toBool(!!options.startclean);
        this.reindex = toBool(!!options.reindex);
        this.addnode = options.addnode;
        this.datadir = options.datadir;
        // this.connect = options.connect;
    }
}

export const createConfigFile = async (options: {
    username: string;
    password: string;
    port: number;
    path: string;
}) => {
    try {
        const { username, password, port, path } = options;
        const directory = join(path || defaultDirObj);
        const directoryExist = existsSync(directory);
        if (!directoryExist) {
            if (path) {
                throw('Provided Directory Does Not Exist');
            } else {
                mkdirSync(defaultDirObj);
            }
        }
        const filePath = join(directory, 'litecoin.conf');
        const fileExist = existsSync(filePath);
        if (fileExist) throw('litecoin.conf file Already Exists in the Provided Directory!');

        const fileData = `
rpcuser=${username}
rpcpassword=${password}
txindex=1

[main]
rpcport=9332

[test]
rpcport=19332
`;

        writeFileSync(filePath, fileData.trim());
        return { data: `litecoin.conf file was created` };
    } catch (error) {
        return { error: error || 'Creating Config File Undefined Error' };
    }
};

export const createRpcClientFromDatadir = (datadir?: string, port?: number) => {
    const connectionConfig = readRpcConnectionConfigFromDatadir(datadir, port);
    if (!connectionConfig) return null;
    return new RpcClient(connectionConfig);
};

export const readRpcConnectionConfigFromDatadir = (datadir?: string, port?: number): IRpcConnectionConfig | null => {
    const path = join(datadir || defaultDirObj);
    const configFilePath = join(path, `litecoin.conf`);
    if (!existsSync(configFilePath)) return null;

    const confFile = readFileSync(configFilePath, { encoding: 'utf8' });
    const configObj: any = structureConfFile(confFile);
    if (!configObj.rpcuser || !configObj.rpcpassword) return null;

    const rpcPort = Number(port || configObj.rpcport || process.env.RPC_PORT || 19332) || 19332;
    return {
        username: configObj.rpcuser,
        password: configObj.rpcpassword,
        host: configObj.rpchost || 'localhost',
        port: rpcPort,
        timeout: 20000,
    };
};

function parseRpcResponse(statusCode: number, payload: any) {
    const normalized = typeof payload === 'string'
        ? (() => {
            try {
                return JSON.parse(payload);
            } catch {
                return payload;
            }
        })()
        : payload;

    if (statusCode === 401) {
        return { error: 'Unauthorized', statusCode, IECode: 4 };
    }

    if (normalized && typeof normalized === 'object') {
        if (Object.prototype.hasOwnProperty.call(normalized, 'error') && normalized.error !== null && normalized.error !== undefined) {
            const errMessage = typeof normalized.error === 'string'
                ? normalized.error
                : normalized.error?.message || 'Undefined Error';
            return {
                error: errMessage,
                statusCode,
                IECode: 2,
                EECode: normalized.error?.code || 0,
            };
        }

        if (Object.prototype.hasOwnProperty.call(normalized, 'result')) {
            return { data: normalized.result, statusCode };
        }
    }

    return {
        error: normalized?.error?.message || normalized?.message || 'Undefined Error',
        statusCode,
        IECode: 3,
        EECode: normalized?.error?.code || 0,
    };
}

export const callRpcFromDatadir = async (
    datadir: string | undefined,
    port: number | undefined,
    method: string,
    params: any[] = [],
    walletName?: string,
) => {
    const connectionConfig = readRpcConnectionConfigFromDatadir(datadir, port);
    if (!connectionConfig) {
        return { error: 'No RPC Client initialized' };
    }

    const normalizedMethod = String(method || '').trim();
    if (!normalizedMethod) {
        return { error: 'Missing RPC method' };
    }

    if (!walletName) {
        return new RpcClient(connectionConfig).call(normalizedMethod, ...params);
    }

    const requestObj = {
        id: Date.now(),
        method: normalizedMethod,
        params,
    };
    const walletPath = `/wallet/${encodeURIComponent(String(walletName).trim())}`;
    const url = `http://${connectionConfig.host}:${connectionConfig.port}${walletPath}`;
    try {
        const response = await axios.post(url, requestObj, {
            auth: {
                username: connectionConfig.username,
                password: connectionConfig.password,
            },
            timeout: connectionConfig.timeout,
            headers: {
                Host: 'localhost',
                'Content-Type': 'text/plain',
            },
            validateStatus: () => true,
        });
        return parseRpcResponse(response.status, response.data);
    } catch (error: any) {
        return { error: error?.message || error || 'Undefined Error' };
    }
};

export const startWalletNode = async (walletNodeOptions: any) => {
  try {
    const isTestnet = walletNodeOptions.testnet;

    // 🔒 ensure expected LTC RPC port and server=1
    const expectedRpcPort = walletNodeOptions.rpcport ??
      (isTestnet ? 19332 : 9332);
    walletNodeOptions.rpcport = expectedRpcPort;
    if (walletNodeOptions.server === undefined) walletNodeOptions.server = 1;

    const flagsObject = new FlagsObject(walletNodeOptions);

    // Read config File
    const path = join(flagsObject.datadir || defaultDirObj);
    const configFilePath = join(path, `litecoin.conf`);
    const isConfFileExist = existsSync(configFilePath);
    const confFile = isConfFileExist
      ? readFileSync(configFilePath, { encoding: 'utf8' })
      : '';
    const configObj: any = isConfFileExist ? structureConfFile(confFile) : {};
    configObj.rpcuser = configObj.rpcuser || process.env.RPC_USER;
    configObj.rpcpassword = configObj.rpcpassword || process.env.RPC_PASS;
    configObj.rpchost = configObj.rpchost || process.env.RPC_HOST;
    configObj.rpcport = configObj.rpcport || process.env.RPC_PORT;
    if (!configObj.rpcuser || !configObj.rpcpassword) {
      throw(isConfFileExist
        ? `Incorrect Config File ${path}`
        : `Config file (litecoin.conf) doesn't exist in: ${path} and RPC credentials were not provided`);
    }

    // normalize rpcport for downstream checks
    configObj.rpcport = Number(configObj.rpcport || expectedRpcPort) || expectedRpcPort;

    // ✅ flags MUST include -rpcport and -server
    const flagsString = convertFlagsObjectToString(flagsObject);
    const filePath = `"${resolveExecutableCoreBinary(coreFilePathObj.LTC)}"`;
    let filePathWithFlags = `${filePath}${flagsString}`;

// ensure rpcport + server flags are present
if (!filePathWithFlags.includes('-rpcport=')) {
  filePathWithFlags += ` -rpcport=${expectedRpcPort}`;
}
if (!filePathWithFlags.includes('-server=')) {
  filePathWithFlags += ' -server=1';
}


    console.log('cli equivalent command ' + filePathWithFlags);
    console.log(`[rpc] isTestnet=${isTestnet} rpcport=${expectedRpcPort} datadir=${path}`);

    if (!filePathWithFlags) throw(`Error with Starting Node. Code 1`);
    return await checkIsCoreStarted(filePathWithFlags, configObj, isTestnet, expectedRpcPort);
  } catch(error: any) {
    return { error: error.message || error || 'Undefined Error' };
  }
};


export const stopWalletNode = async () => {
        const stopRes = await fasitfyServer.rpcClient?.call('stop');
        const checkPromise = new Promise(async checkResolve => {
            const checkRes = await fasitfyServer.rpcClient.call('getblockchaininfo');
            checkRes?.error?.includes("ECONNREFUSED")
                ? checkResolve(true)
                : await checkPromise;
        });
        fasitfyServer.mainSocketService.stopBlockCounting();
        fasitfyServer.rpcClient = null;
        fasitfyServer.rpcPort = null;
        return { data: true };
}

const convertFlagsObjectToString = (flagsObject: any) => {
    const _toStr = (flag: string, value: string | boolean) => ` -${flag}=${value}`;
    let str = ' -txindex=1 -printtoconsole=0';
    Object.keys(flagsObject)
        .forEach((flag: string) => {
            if (flag === 'datadir' && flagsObject[flag]) return str += _toStr(flag, `"${flagsObject[flag]}"`);
            if (flagsObject[flag]) return str += _toStr(flag, flagsObject[flag]);
        });
    return str || '';
}

const resolveExecutableCoreBinary = (binaryPath: string) => {
    if (process.platform !== 'linux') {
        return binaryPath;
    }

    try {
        accessSync(binaryPath, constants.X_OK);
        return binaryPath;
    } catch {
        // fall through to extraction/copy fallbacks
    }

    const cacheDir = join(tmpdir(), 'tradelayer-wallet-core');
    mkdirSync(cacheDir, { recursive: true });
    const cachedBinaryPath = join(cacheDir, basename(binaryPath));
    const archivePath = join(dirname(binaryPath), 'litecoin.tar.gz');

    if (existsSync(archivePath)) {
        try {
            execFileSync('tar', ['-xzf', archivePath, '-C', cacheDir], { stdio: 'ignore' });
            const extractedBinaryPath = join(cacheDir, 'litecoin-0.21.2.2', 'bin', basename(binaryPath));
            chmodSync(extractedBinaryPath, 0o755);
            accessSync(extractedBinaryPath, constants.X_OK);
            console.log(`Extracted Litecoin Core binary to writable cache: ${extractedBinaryPath}`);
            return extractedBinaryPath;
        } catch (error) {
            console.error(`Unable to extract Litecoin Core archive at ${archivePath}:`, error);
        }
    }

    try {
        copyFileSync(binaryPath, cachedBinaryPath);
        chmodSync(cachedBinaryPath, 0o755);
        accessSync(cachedBinaryPath, constants.X_OK);
        console.log(`Copied Litecoin Core binary to writable cache: ${cachedBinaryPath}`);
        return cachedBinaryPath;
    } catch (error) {
        console.error(`Unable to prepare executable Litecoin Core binary at ${binaryPath}:`, error);
        return binaryPath;
    }
};

const structureConfFile = (conf: string) => {
    const confObj = {};
    conf.split('\n').forEach((l: string) => {
        const a = l.split('=');
        if (l.startsWith('#') || !a[0] || !a[1]) return;
        confObj[a[0]] = a[1].replace('\r', '');
    });
    return confObj;
};

const checkIsCoreStarted = async (
        filePathWithFlags: string,
        configObj: any,
        isTestnet: boolean,
        expectedRpcPort?: number,
    ) => {
    return new Promise(async (resolve) => {
        const { rpcuser, rpcpassword, rpchost } = configObj;
        const port = Number(expectedRpcPort || configObj.rpcport || (isTestnet ? 19332 : 9332)) || (isTestnet ? 19332 : 9332);
        console.log('port? '+port+' '+isTestnet)
        const rpcClientOptions = {
            username: rpcuser,
            password: rpcpassword,
            host: rpchost || 'localhost',
            port: port,
            timeout: 20000,
        };

        const client = new RpcClient(rpcClientOptions);
        const toMessage = (value: any) => String(value?.message || value?.error || value || '');
        const isConnectionRefused = (value: any) => {
            const msg = toMessage(value).toLowerCase();
            return msg.includes('econnrefused') || msg.includes('connection refused');
        };
        const isAuthError = (value: any) => {
            const msg = toMessage(value).toLowerCase();
            return value?.code === 401
                || msg.includes('401')
                || msg.includes('unauthorized')
                || msg.includes('forbidden')
                || msg.includes('incorrect rpcuser')
                || msg.includes('incorrect rpcpassword')
                || msg.includes('authorization failed')
                || msg.includes('authentication failed');
        };
        const isTransientRpcStartupError = (value: any) => {
            const msg = toMessage(value).toLowerCase();
            return value?.code === -28
                || msg.includes('loading block index')
                || msg.includes('rewinding blocks')
                || msg.includes('verifying blocks')
                || msg.includes('warming up')
                || msg.includes('work queue depth exceeded')
                || msg.includes('socket hang up')
                || msg.includes('etimedout')
                || msg.includes('econnreset');
        };

        const probeCore = async (): Promise<{ state: 'ready' | 'offline' | 'starting' | 'auth-error' | 'error'; error?: any }> => {
            try {
                const check = await client.call('getblockchaininfo');
                if (check?.data) return { state: 'ready' };
                const error = check?.error || check;
                if (isConnectionRefused(error)) return { state: 'offline', error };
                if (isAuthError(error)) return { state: 'auth-error', error };
                if (isTransientRpcStartupError(error)) return { state: 'starting', error };
                return { state: 'error', error };
            } catch (error: any) {
                if (isConnectionRefused(error)) return { state: 'offline', error };
                if (isAuthError(error)) return { state: 'auth-error', error };
                if (isTransientRpcStartupError(error)) return { state: 'starting', error };
                return { state: 'error', error: error?.message || error || 'Undefined Error' };
            }
        };
        const attachToCore = () => {
            fasitfyServer.rpcClient = client;
            fasitfyServer.rpcPort = port;
            fasitfyServer.mainSocketService.startBlockCounting(2000);
            return { data: true, attached: true };
        };
        const watchForCoreAttach = async () => {
            while (true) {
                const checkRes = await probeCore();
                if (checkRes.state === 'ready') {
                    clearTimeout(timeoutId);
                    console.log(`Attached to existing Litecoin Core RPC on port ${port}.`);
                    attachToCore();
                    return;
                }
                if (checkRes.state === 'auth-error') {
                    clearTimeout(timeoutId);
                    console.error(credentialsError(checkRes.error));
                    return;
                }
                if (checkRes.state === 'error') {
                    clearTimeout(timeoutId);
                    console.error(`Litecoin RPC on port ${port} returned an unexpected error: ${toMessage(checkRes.error)}`);
                    return;
                }

                await new Promise(res => setTimeout(() => res(true), 1000));
            }
        };
        const credentialsError = (error: any) => {
            return `A Litecoin node is already listening on RPC port ${port}, but it rejected the wallet RPC credentials. Update litecoin.conf or the wallet RPC_USER/RPC_PASS settings. ${toMessage(error)}`;
        };

        const firstCheck = await probeCore();
        if (firstCheck.state === 'ready') {
            console.log(`Attached to existing Litecoin Core RPC on port ${port}.`);
            return resolve(attachToCore());
        }
        if (firstCheck.state === 'auth-error') {
            return resolve({ error: credentialsError(firstCheck.error) });
        }
        if (firstCheck.state === 'error') {
            return resolve({ error: `Litecoin RPC on port ${port} returned an unexpected error: ${toMessage(firstCheck.error)}` });
        }

        const timeoutId = setTimeout(async () => {
            await fasitfyServer.tradelayerService.stop();
            resolve({ error: 'Core Starting TimedOut: 120 seconds' });
        }, 120000);

        if (firstCheck.state === 'offline') {
            exec(filePathWithFlags, (error, stdout, stderr) => {
                console.log('inside exec '+error+' '+stdout)
                const execMessage = toMessage(stderr || error?.message || error || stdout).toLowerCase();
                if (
                    execMessage.includes('cannot obtain a lock')
                    || execMessage.includes('probably already running')
                    || execMessage.includes('data directory') && execMessage.includes('lock')
                ) {
                    console.log(`Litecoin Core already owns the datadir; waiting to attach to RPC on port ${port}.`);
                    return;
                }
                if (fasitfyServer.mainSocketService?.currentSocket) {
                    fasitfyServer.mainSocketService.currentSocket
                        .emit("core-error", stderr || error?.message || error || stdout);
                }
                fasitfyServer.rpcClient = null;
                fasitfyServer.rpcPort = null;
            });
        } else {
            console.log(`Found Litecoin Core already starting on RPC port ${port}; waiting to attach.`);
        }
        void watchForCoreAttach();
        resolve({
            data: true,
            attached: false,
            starting: true,
            message: 'Loading block index...',
        });
    });
};
