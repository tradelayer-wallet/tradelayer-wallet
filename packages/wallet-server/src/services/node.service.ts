import { exec } from "child_process";
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
        const path = join(flagsObject.datadir || defaultDirObj);
        const configFilePath = join(path, `litecoin.conf`);
        const isConfFileExist = existsSync(configFilePath);
        if (!isConfFileExist) throw(`Config file (litecoin.conf) doesn't exist in: ${path}`);
        const confFile = readFileSync(configFilePath, { encoding: 'utf8' });
        const configObj: any = structureConfFile(confFile);
        if (!configObj.rpcuser || !configObj.rpcpassword) throw(`Incorrect Config File ${path}`);

        // Run The core
        const flagsString = convertFlagsObjectToString(flagsObject);
        const filePath = `"${coreFilePathObj.LTC}"`;
        const filePathWithFlags = `${filePath}${flagsString}`;
        if (!filePathWithFlags) throw(`Error with Starting Node. Code 1`);
        return await checkIsCoreStarted(filePathWithFlags, configObj, isTestnet);;
    } catch(error) {
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
    ) => {
    return new Promise(async (resolve) => {
        const { rpcuser, rpcport, rpcpassword, rpchost } = configObj;
        const port = rpcport ? rpcport : isTestnet ? 19332 : 9332;
        const client = new RpcClient({
            username: rpcuser,
            password: rpcpassword,
            host: rpchost || 'localhost',
            port: port,
            timeout: 2000,
        });

        const isActiveCheck = () => {
            return new Promise(async (res) => {
                const check = await client.call('getblockchaininfo');
                if (check.data) res(2);
                if (check.error && !check.error.includes('ECONNREFUSED')) res(check);
                if (check.error && check.error.includes('ECONNREFUSED')) res(0);
            });
        };
        const firstCheck = await isActiveCheck();
        if (firstCheck !== 0) return resolve({ error: 'The core is probably Already Running'});

        exec(filePathWithFlags, (error, stdout, stderr) => {
            fasitfyServer.mainSocketService.currentSocket
                .emit("core-error", stderr || error?.message || error || stdout);
            fasitfyServer.rpcClient = null;
            fasitfyServer.rpcPort = null;
        });
        setTimeout(() => resolve({error: 'Core Starting TimedOut: 10 secs'}), 10000);

        const finalCheck = () => new Promise(async checkResolve => {
            await client.call('getblockchaininfo')
                .then(async checkRes => {
                    if (!checkRes?.error?.includes("ECONNREFUSED")) {
                        fasitfyServer.rpcClient = client;
                        fasitfyServer.rpcPort = port;
                        fasitfyServer.mainSocketService.startBlockCounting(2000);
                        checkResolve({ data: true });
                    } else {
                        const subCheck = await finalCheck();
                        checkResolve({ data: subCheck });
                    }
                });
        });

        const finalRes = await finalCheck();
        resolve({ data: finalRes });
    });
};