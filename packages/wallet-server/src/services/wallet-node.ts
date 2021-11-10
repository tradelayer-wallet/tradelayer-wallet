import { readFileSync, existsSync, writeFileSync, mkdirSync, writeFile } from 'fs'
import { join } from 'path'
import { ChildProcess, exec } from 'child_process';
import { fasitfyServer } from '../index';
import { coreFilePathObj, defaultDirObj } from '../conf/windows.conf';
import { addTESTNETNodeServer } from '../conf/conf';
import { initServerConnection, myVersions, walletSocketSevice } from '../sockets';
import { customLogger } from '../socket-script/common/logger';
import { Client } from 'litecoin'
import { asyncClient } from '../socket-script/common/async-client';

const defaultDir = defaultDirObj;
const addNodeServer = addTESTNETNodeServer;

export interface IFlagsObject {
    testnet: number;
    txindex: number;
    startclean: number;
    reindex: number;
    addnode: string;
    datadir: string;
}

export interface INodeConfig  {
    username: string;
    password: string;
    port: number;
    path: string;
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

class FlagsObject implements IFlagsObject {
    public testnet: number = 0;
    public txindex: number = 0;
    public startclean: number = 0;
    public reindex: number = 0;
    public addnode: string = null;
    public datadir: string = null;
    constructor(options: any) {
        const toBool = (param: boolean) => param ? 1 : 0;

        this.testnet = toBool(!!options.testnet);
        this.txindex = toBool(!!options.txindex);
        this.startclean = toBool(!!options.startclean);
        this.reindex = toBool(!!options.reindex);
        this.addnode = options.addnode;
        this.datadir = options.datadir;
    }
}

class WalletNodeInstance {
    private nodeProcess: ChildProcess;
    private defaultPath: string;
    constructor() {}

    convertFlagsObjectToString(flagsObject: any) {
        const _toStr = (flag: string, value: string | boolean) => ` -${flag}=${value}`;
        let str = '';
        Object.keys(flagsObject)
            .forEach((flag: string) => {
                if (flag === 'testnet') return str += _toStr(flag, flagsObject[flag]);
                // if (flag === 'datadir') return str += flagsObject[flag] ? _toStr(flag, flagsObject[flag]) : _toStr(flag, defaultDir);
                if (flagsObject[flag]) return str += _toStr(flag, flagsObject[flag]);
            });
        return str || '';
    }

    async startWalletNode(options: any) {
        const flagsObject = new FlagsObject(options);
        customLogger(`Start Wallet Node: ${JSON.stringify(options)}`);

        const isTestNet = !!flagsObject.testnet;
        const path = flagsObject.datadir || defaultDir;
        this.defaultPath = path;
        if (isTestNet) flagsObject.addnode = addNodeServer;

        const versionGuard = await this._versionGuard(isTestNet);
        if (versionGuard.error || !versionGuard.data) return { error: versionGuard.error};

        const upToDate = this._chechVersions(path, isTestNet);
        if (!upToDate) flagsObject.startclean = 1;
        if (upToDate === 0) flagsObject.reindex = 1;

        //check config file
        const configFilePath = join(path, 'litecoin.conf');
        if (!existsSync(configFilePath)) return { error: `Config file doesn't exist in: ${path}` };
        const confFile = readFileSync(configFilePath, { encoding: 'utf8' });
        const configObj: any = structureConfFile(confFile);
        const { rpcuser, rpcport, rpcpassword } = configObj;
        if (!rpcuser || !rpcport || !rpcpassword) return { error: `Incorrect Config File` };
        // --------

        const flagsString = this.convertFlagsObjectToString(flagsObject);
        const file = `"${coreFilePathObj}"`;
        const command = `${file}${flagsString}`;
        const execFileResult = await this.execFileByCommandPromise(command, configObj) as { data: any; error: any };
        customLogger(`exec_${command}: ${JSON.stringify(execFileResult)}`);

        if (execFileResult.error || !execFileResult?.data) {
            const errorMessage = execFileResult?.error;
            const reIndexMessage = "Please restart with -reindex";
            const startCleanMessage = "Please restart with -startclean flag";
            if (errorMessage.includes(reIndexMessage) && !command.includes('-reindex')) {
                return await this.startWalletNode({...options, reindex: true });
            }

            if (errorMessage.includes(startCleanMessage) && !command.includes('-startclean')) {
                return await this.startWalletNode({...options, startclean: true });
            }

            return { error: errorMessage || "Undefined Error (code 53)!" };
        }
        return { data: configObj };
    }

    private execFileByCommandPromise = (command: string, options: any) => {
        const { rpcuser, rpcport, rpcpassword, rpchost } = options;
        const ltcClient = new Client({
            user: rpcuser,
            pass: rpcpassword,
            host: rpchost || 'localhost',
            port: rpcport || 9332,
            ssl: false,
            timeout: 2000,
        });
        const ac = asyncClient(ltcClient);

        const isActiveCheck = () => {
            return new Promise(async (res) => {
                const check = await ac('tl_getinfo');
                check.data || (check.error && !check.error.includes('ECONNREFUSED'))
                    ? res(true) : res(false);
            });
        };

        return new Promise(async (res) => {
            const _isActivePre = await isActiveCheck();
            if (_isActivePre) return res({ data: true });
            this.nodeProcess = exec(command, (error, stdout, stderr) => {
                fasitfyServer.eventEmitter.emit('killer');
                if (stdout || stderr) return res({error: stdout || stderr || 'Undefined Error!'});
                walletSocketSevice.currentSocket.emit('local-node-stopped', stdout || stderr || "Unknown reason");
            });

            const port = parseFloat(rpcport);
            fasitfyServer.nodePort = port;

            const interval = setInterval(async () => {
                const _isActive = await isActiveCheck();
                if (_isActive) {
                    clearInterval(interval);
                    res({ data: true });
                }
            }, 800);

            setTimeout(() => {
                clearInterval(interval);
                res({ error: `No response from RPC! Undefined Reason!` });
            }, 8000);
        });
    }

    private _chechVersions = (path: string, _isTestNetBool: boolean) => {
        try {
            const filePath = join(path, 'tl-wallet.conf');
            if (!existsSync(filePath)) return 0;
            const res = readFileSync(filePath, { encoding: 'utf8' });
            const config = structureConfFile(res);
            const _node = _isTestNetBool ? 'test_nodeVersion' : 'nodeVersion';
            customLogger(`Check versions: ${JSON.stringify(config)}`);
            if (!config[_node]) return 0;
            return config[_node] === myVersions.nodeVersion;
        } catch (error) {
            customLogger(`Check versions Error: ${error.message}`);
            return 0;
        }
    };
    private _versionGuard(isTestNet: boolean) {
        return new Promise<{ error?: string, data?: boolean }>(res => {
            const sss = initServerConnection(fasitfyServer.socketScript, isTestNet);
            sss.socket.on('version-guard', (valid: boolean) => {
                const resolve = valid
                    ? { data: true }
                    : { error: 'The Application need to be updated!' };
                res(resolve);
            });
            sss.socket.on('connect_error', () => {
                res({error: 'Error with API connection.'})
            });
        });
    }

    createNodeConfig(config: INodeConfig) {
        try {
            const { username, password, port, path } = config;
            const fileData = `rpcuser=${username}\nrpcpassword=${password}\nrpcport=${port}\ntxindex=1`;
            if (!existsSync(path)) mkdirSync(path);
            const filePath = join(path, 'litecoin.conf');
            writeFileSync(filePath, fileData);
            customLogger(`Create Node Config file: ${fileData}`);
            return { data: true };
        } catch (error) {
            customLogger(`Create Node Config file: ${error.message}`);
            return { error: error.message };
        }
    }

    createWalletconfig(_isTestNetBool: boolean) {
        const path = this.defaultPath;
        try {
            if (!existsSync(path)) mkdirSync(path);
            const filePath = join(path, 'tl-wallet.conf');
            const _node = _isTestNetBool ? 'test_nodeVersion' : 'nodeVersion';
            const { nodeVersion } = myVersions;
            let data = `${_node}=${nodeVersion}\n`;
            if (existsSync(filePath)) {
                try {
                    const existing = readFileSync(filePath, { encoding: 'utf8' });
                    const _existing = structureConfFile(existing);
                    data = '';
                    Object.keys(_existing).forEach(k => {
                        if (k !== _node) data = data + `${k}=${_existing[k]}\n`;
                    });
                    data = data + `${_node}=${nodeVersion}\n`;
                } catch (err) {
                    data = `${_node}=${nodeVersion}\n`;
                }
            }
            const res = writeFileSync(filePath, data);
            customLogger(`Create Wallet Conf File: ${data}`);
            return { data: true };
        } catch (error) {
            customLogger(`Create Wallet Conf File: ${error.message}`);
            return { error: error.message };
        }
    };
}

export const myWalletNode = new WalletNodeInstance();