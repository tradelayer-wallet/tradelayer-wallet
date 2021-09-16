import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ChildProcess, exec } from 'child_process';
import { fasitfyServer } from '../index';
import { addTESTNETNodeServer, coreFilePathObj, defaultDirObj } from '../conf/conf';
 
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

export const startWalletNode = async (path: string) => {
    try {
        const filePath = join(defaultDir, 'litecoin.conf');
        if (!existsSync(filePath)) return { error: `Config file doesn't exist` };
        const res = readFileSync(filePath, { encoding: 'utf8' });
        const config = structureConfFile(res);
        if (!config['rpcuser'] || !config['rpcport'] || !config['rpcpassword']) return { error: `Incorrect Config File` };

        const file = coreFilePathObj.WINDOWS;
        const command = file;
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

export const createNewNode = async (configs: { username: string, password: string, port: number, path: string,}) => {
    try {
        const { username, password, port, path } = configs;
        const fileData = `rpcuser=${username}\nrpcpassword=${password}\nrpcport=${port}\ntestnet=1\ntxindex=1\naddnode=${addNodeServer}`;
        if (!existsSync(defaultDir)) mkdirSync(defaultDir)
        const filePath = join(defaultDir, 'litecoin.conf');
        const res = writeFileSync(filePath, fileData);
        return { data: true };
    } catch (error) {
        return { error: error.message };
    }
};
