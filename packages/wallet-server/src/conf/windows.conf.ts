import { homedir } from 'os';
import { join } from 'path';

export const defaultDirObj = `${homedir()}/AppData/Roaming/Litecoin`;
export const coreFilePathObj = {
    LTC: join(__dirname, 'litecoind.exe'),
    // BTC: join(__dirname, 'bitcoind.exe'),
};