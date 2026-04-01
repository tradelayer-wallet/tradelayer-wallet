import { exec } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { coreFilePathObj, defaultDirObj } from "../conf/windows.conf";
import { RpcClient } from 'tl-rpc';
import { fasitfyServer } from "..";
import { FastifyServer } from "../fastify-server";
import fastify from "fastify";
import { loadEnvIntoProcess } from '../utils/env.util';
loadEnvIntoProcess();


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
    const path = join(datadir || defaultDirObj);
    const configFilePath = join(path, `litecoin.conf`);
    if (!existsSync(configFilePath)) return null;

    const confFile = readFileSync(configFilePath, { encoding: 'utf8' });
    const configObj: any = structureConfFile(confFile);
    if (!configObj.rpcuser || !configObj.rpcpassword) return null;

    const rpcPort = Number(port || configObj.rpcport || process.env.RPC_PORT || 19332) || 19332;
    return new RpcClient({
        username: configObj.rpcuser,
        password: configObj.rpcpassword,
        host: configObj.rpchost || 'localhost',
        port: rpcPort,
        timeout: 20000,
    });
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
    if (!isConfFileExist) throw(`Config file (litecoin.conf) doesn't exist in: ${path}`);
    const confFile = readFileSync(configFilePath, { encoding: 'utf8' });
    const configObj: any = structureConfFile(confFile);
    if (!configObj.rpcuser || !configObj.rpcpassword) throw(`Incorrect Config File ${path}`);

    // normalize rpcport for downstream checks
    configObj.rpcport = Number(configObj.rpcport || expectedRpcPort) || expectedRpcPort;

    // ✅ flags MUST include -rpcport and -server
    const flagsString = convertFlagsObjectToString(flagsObject);
    const filePath = `"${coreFilePathObj.LTC}"`;
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
        const isConnectionRefused = (value: any) => {
            const msg = String(value?.message || value || '');
            return msg.includes('ECONNREFUSED') || msg.includes('connection refused');
        };

        const isActiveCheck = async () => {
            try {
                const check = await client.call('getblockchaininfo');
                if (check?.data) return 2;
                if (check?.error && isConnectionRefused(check.error)) return 0;
                return check;
            } catch (error: any) {
                if (isConnectionRefused(error)) return 0;
                return { error: error?.message || error || 'Undefined Error' };
            }
        };

        const firstCheck = await isActiveCheck();
        if (firstCheck !== 0) {
            return resolve({ error: 'The core is already running, try shutting down litecoind in the task manager, restarting the wallet or restarting your PC.' });
        }

        exec(filePathWithFlags, (error, stdout, stderr) => {
            console.log('inside exec '+error+' '+stdout)
            if (fasitfyServer.mainSocketService?.currentSocket) {
                fasitfyServer.mainSocketService.currentSocket
                    .emit("core-error", stderr || error?.message || error || stdout);
            }
            fasitfyServer.rpcClient = null;
            fasitfyServer.rpcPort = null;
        });

        const timeoutId = setTimeout(async () => {
            await fasitfyServer.tradelayerService.stop();
            resolve({ error: 'Core Starting TimedOut: 120 seconds' });
        }, 120000);

        const finalCheck = (): Promise<{ data: boolean }> => new Promise(async (checkResolve) => {
            try {
                const checkRes = await client.call('getblockchaininfo');
                if (!checkRes?.error || !isConnectionRefused(checkRes.error)) {
                    clearTimeout(timeoutId);
                    fasitfyServer.rpcClient = client;
                    fasitfyServer.rpcPort = port;
                    fasitfyServer.mainSocketService.startBlockCounting(2000);
                    checkResolve({ data: true });
                    return;
                }
            } catch (error: any) {
                if (!isConnectionRefused(error)) {
                    clearTimeout(timeoutId);
                    checkResolve({ data: false });
                    return;
                }
            }

            await new Promise(res => setTimeout(() => res(true), 1000));
            const subCheck = await finalCheck();
            checkResolve(subCheck);
        });

        const finalRes = await finalCheck();
        resolve({ data: finalRes });
    });
};
