import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ChildProcess, exec } from 'child_process';
import { fasitfyServer } from '../index';
import { addTESTNETNodeServer, coreFilePathObj, defaultDirObj } from '../conf/conf';
import { myVersions } from '../sockets';
 
const defaultDir = defaultDirObj.WINDOWS;
const addNodeServer = addTESTNETNodeServer;

let nodeProcess: ChildProcess;

const execFileByCommandPromise = (command: string) => {
    return new Promise((res) => {
        nodeProcess = exec(command, (error) => {
            if (error) res({error});
        });
        setTimeout(() => res({ data: true }), 1000);
    });
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

export const startWalletNode = async (path: string, isTestNet: boolean) => {
    try {
        const upToDate = chechVersions(isTestNet);
        const filePath = join(defaultDir, 'litecoin.conf');
        if (!existsSync(filePath)) return { error: `Config file doesn't exist` };
        const res = readFileSync(filePath, { encoding: 'utf8' });
        const config = structureConfFile(res);
        if (!config['rpcuser'] || !config['rpcport'] || !config['rpcpassword']) return { error: `Incorrect Config File` };
        const testNetFlag = isTestNet ? `-testnet -addnode=${addNodeServer}` : '';
        const startCleanFlag = upToDate ? '' : '-startclean';
        const file = `"${coreFilePathObj.WINDOWS}"`;
        const command = `${file} ${testNetFlag} ${startCleanFlag}`;
        const execFileResult = await execFileByCommandPromise(command) as { data: any; error: any };
        if (execFileResult.error || !execFileResult?.data) {
            return { error: execFileResult?.error?.message || "Can't start the Local Node" };
        }
        const port = parseFloat(config['rpcport']);
        fasitfyServer.nodePort = port;
        return { data: config };
    } catch (error) {
        return { error: error.message };
    }
};

const chechVersions = (_isTestNetBool: boolean) => {
    try {
        const filePath = join(defaultDir, 'tradelayer.conf');
        if (!existsSync(filePath)) return false;
        const res = readFileSync(filePath, { encoding: 'utf8' });
        const config = structureConfFile(res);
        const _node = _isTestNetBool ? 'test_nodeVersion' : 'nodeVersion';
        return config[_node] === myVersions.nodeVersion;
    } catch (error) {
        return false;
    }
};

export const createTLconfigFile = (_isTestNetBool: boolean) => {
    try {
        if (!existsSync(defaultDir)) mkdirSync(defaultDir);
        const filePath = join(defaultDir, 'tradelayer.conf');
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
        return { data: true };
    } catch (error) {
        return { error: error.message };
    }
};

export const createNewNode = async (configs: { username: string, password: string, port: number, path: string,}) => {
    try {
        const { username, password, port, path } = configs;
        const fileData = `rpcuser=${username}\nrpcpassword=${password}\nrpcport=${port}\ntxindex=1`;
        if (!existsSync(defaultDir)) mkdirSync(defaultDir)
        const filePath = join(defaultDir, 'litecoin.conf');
        const res = writeFileSync(filePath, fileData);
        return { data: true };
    } catch (error) {
        return { error: error.message };
    }
};
