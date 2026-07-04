import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { coreFilePathObj, defaultDirObj } from "../conf/windows.conf";
import { RpcClient } from 'tl-rpc';
import { fasitfyServer } from "..";

interface IFlagsObject {
    testnet: number;
    txindex: number;
    startclean: number;
    reindex: number;
    addnode: string;
    datadir: string;
}

type StartCheckResult = { data?: boolean; error?: string };

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
                throw('Provided Directory Dont exist');
            } else {
                mkdirSync(defaultDirObj)
            }
        }
        const filePath = join(directory, 'litecoin.conf');
        const fileExist = existsSync(filePath);
        if (fileExist) throw('litecoin.conf file Already exist in provided directory!');
        const fileData = `rpcuser=${username}\nrpcpassword=${password}\nrpcport=${port}\ntxindex=1`;
        writeFileSync(filePath, fileData);
        return { data: `litecoin.conf file was created` };
    } catch (error) {
        return { error: error || 'Creating Config File Undefined Error' };
    }
};

export const startWalletNode = async (walletNodeOptions: any) => {
    try {
        const isTestnet = walletNodeOptions.testnet;
        // if (isTestnet) walletNodeOptions.connect = "178.62.46.195:19333";
        const flagsObject = new FlagsObject(walletNodeOptions);
        // Read config File
        const litecoinDatadir = join(flagsObject.datadir || defaultDirObj);
        const configFilePath = join(litecoinDatadir, `litecoin.conf`);
        const isConfFileExist = existsSync(configFilePath);
        if (!isConfFileExist) throw(`Config file (litecoin.conf) doesn't exist in: ${litecoinDatadir}`);
        const confFile = readFileSync(configFilePath, { encoding: 'utf8' });
        const configObj: any = structureConfFile(confFile);
        if (!configObj.rpcuser || !configObj.rpcpassword) throw(`Incorrect Config File ${litecoinDatadir}`);

        // Run The core
        const flags = convertFlagsObjectToArgs(flagsObject);
        if (!coreFilePathObj.LTC) throw(`Error with Starting Node. Core binary is missing`);

    const coreProcess: ChildProcessWithoutNullStreams = spawn(coreFilePathObj.LTC, flags, {
            windowsHide: true,
        });
        const coreStarted: StartCheckResult = await checkIsCoreStarted(coreProcess, configObj, isTestnet);
        if (coreStarted.error) {
            coreProcess.kill();
            return coreStarted;
        }

        return coreStarted;
    } catch(error) {
        return { error: error.message || error || 'Undefined Error' };
    }
};

export const stopWalletNode = async () => {
        const rpcClient = fasitfyServer.rpcClient;
        if (!rpcClient) {
            fasitfyServer.rpcClient = null;
            fasitfyServer.rpcPort = null;
            fasitfyServer.mainSocketService?.stopBlockCounting();
            return { data: true };
        }

        try {
            await rpcClient.call('stop');
        } catch(error) {
            // If node is already stopping, this can fail; continue cleanup.
        }

        const startedAt = Date.now();
        const shutdownTimeoutMs = 12000;
        while (Date.now() - startedAt < shutdownTimeoutMs) {
            try {
                const checkRes = await rpcClient.call('getblockchaininfo');
                if (checkRes?.error?.includes("ECONNREFUSED")) break;
            } catch(error: any) {
                if (error?.message?.includes("ECONNREFUSED")) {
                    break;
                }
            }
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        fasitfyServer.mainSocketService.stopBlockCounting();
        fasitfyServer.rpcClient = null;
        fasitfyServer.rpcPort = null;
        return { data: true };
}

const convertFlagsObjectToArgs = (flagsObject: any) => {
    const flags = ['-txindex=1', '-printtoconsole=0'];
    Object.keys(flagsObject)
        .forEach((flag: string) => {
            if (!flagsObject[flag]) return;
            if (flag === 'datadir') return flags.push(`-${flag}="${flagsObject[flag]}"`);
            return flags.push(`-${flag}=${flagsObject[flag]}`);
        });
    return flags;
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
        coreProcess: ChildProcessWithoutNullStreams,
        configObj: any,
        isTestnet: boolean,
    ): Promise<StartCheckResult> => {
    const timeoutMs = 12000;
    const pollMs = 300;

    return new Promise<StartCheckResult>((resolve) => {
        const { rpcuser, rpcport, rpcpassword, rpchost } = configObj;
        const port = rpcport ? Number(rpcport) : isTestnet ? 18332 : 8332;
        const client = new RpcClient({
            username: rpcuser,
            password: rpcpassword,
            host: rpchost || 'localhost',
            port: port,
            timeout: 2000,
        });
        const start = Date.now();

        const finalCheck = async () => {
            try {
                const checkRes: any = await client.call('getblockchaininfo');
                if (!checkRes || !checkRes.error) {
                    fasitfyServer.rpcClient = client;
                    fasitfyServer.rpcPort = port;
                    fasitfyServer.mainSocketService.startBlockCounting(2000);
                    resolve({ data: true });
                    return true;
                }

                if (!checkRes.error.includes("ECONNREFUSED")) {
                    resolve({ error: checkRes.error });
                    return true;
                }
            } catch (error: any) {
                if (!error?.message?.includes("ECONNREFUSED")) {
                    resolve({ error: error.message || error });
                    return true;
                }
            }
            return false;
        };

        const runChecks = async () => {
            while (Date.now() - start < timeoutMs) {
                const isDone = await finalCheck();
                if (isDone) return;
                await new Promise(resolveWait => setTimeout(resolveWait, pollMs));
            }
            resolve({ error: `Core Starting TimedOut: ${timeoutMs / 1000} secs` });
        };

        coreProcess.once('error', (error) => {
            resolve({ error: error.message || String(error) });
        });
        coreProcess.once('exit', (code) => {
            if (code !== 0) {
                resolve({ error: `Core exited with code ${code}` });
            }
        });
        runChecks();
    });
}
