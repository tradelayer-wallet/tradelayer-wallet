import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { defaultDirObj } from "../conf/windows.conf";
import { WireRpcClient } from "../utils/rpc-wire";
import { fasitfyServer } from "..";

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
                throw('Provided Directory Dont exist');
            } else {
                mkdirSync(defaultDirObj)
            }
        }
        const filePath = join(directory, 'litecoin.conf');
        const fileExist = existsSync(filePath);
        if (fileExist) throw('litecoin.conf file Already exist in provided directory!');
        if (/[\r\n]/.test(`${username}${password}`)) throw('Username and password cannot contain line breaks');
        const fileData = `rpcuser=${username}\nrpcpassword=${password}\nrpcport=${port}\ntxindex=1`;
        // The file holds the RPC password: owner read/write only (POSIX; ignored on Windows).
        writeFileSync(filePath, fileData, { mode: 0o600 });
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
        const path = join(flagsObject.datadir || defaultDirObj);
        const configFilePath = join(path, `litecoin.conf`);
        const isConfFileExist = existsSync(configFilePath);
        if (!isConfFileExist) throw(`Config file (litecoin.conf) doesn't exist in: ${path}`);
        const confFile = readFileSync(configFilePath, { encoding: 'utf8' });
        const configObj: any = structureConfFile(confFile);
        if (!configObj.rpcuser || !configObj.rpcpassword) throw(`Incorrect Config File ${path}`);

        return await checkIsCoreStarted(configObj, isTestnet);
    } catch(error) {
        return { error: error.message || error || 'Undefined Error' };
    }
};

// A failed stop keeps the connection: the node may still be running and the wallet still
// needs to reach it. A node that is already down (ECONNREFUSED) counts as stopped.
export const stopWalletNode = async () => {
    const client = fasitfyServer.rpcClient;
    if (client) {
        const stopRes = await client.call('stop');
        if (stopRes.error && !stopRes.error.includes('ECONNREFUSED')) return { error: stopRes.error };
    }
    fasitfyServer.mainSocketService.stopBlockCounting();
    fasitfyServer.rpcClient = null;
    fasitfyServer.rpcPort = null;
    return { data: true };
};

// Splits at the first '=' only: the value is everything after it, so a password that contains '=' is read whole.
const structureConfFile = (conf: string) => {
    const confObj = {};
    conf.split('\n').forEach((l: string) => {
        const eq = l.indexOf('=');
        if (l.startsWith('#') || eq < 1 || eq === l.length - 1) return;
        confObj[l.slice(0, eq)] = l.slice(eq + 1).replace('\r', '');
    });
    return confObj;
};

// Litecoin Core's RPC_IN_WARMUP: the node has the RPC port open and is still loading its block index.
const RPC_IN_WARMUP = -28;
const CORE_START_ATTEMPTS = 300;
const CORE_START_INTERVAL_MS = 1000;

// Waits while the node is starting (no RPC port yet, or still loading). Any other answer that is
// not a result (a wrong password, a timeout) is reported as the error, not as a started node.
const checkIsCoreStarted = async (
        configObj: any,
        isTestnet: boolean,
    ) => {
    const { rpcuser, rpcport, rpcpassword, rpchost } = configObj;
    const port = rpcport ? rpcport : isTestnet ? 19332 : 9332;
    const client = new WireRpcClient({
        username: rpcuser,
        password: rpcpassword,
        host: rpchost || 'localhost',
        port: port,
        timeout: 2000,
    });

    for (let attempt = 1; ; attempt++) {
        const checkRes = await client.call('getblockchaininfo');
        if (checkRes.data) {
            fasitfyServer.rpcClient = client;
            fasitfyServer.rpcPort = port;
            fasitfyServer.mainSocketService.startBlockCounting(2000);
            return { data: true };
        }
        const starting = checkRes.error?.includes('ECONNREFUSED') || checkRes.EECode === RPC_IN_WARMUP;
        if (!starting || attempt >= CORE_START_ATTEMPTS) return { error: checkRes.error || 'Undefined Error' };
        await new Promise((res) => setTimeout(res, CORE_START_INTERVAL_MS));
    }
};