import { homedir } from 'os';
import { join } from 'path';

export const defaultDirObj = `${homedir()}/.litecoin/`;
export const coreFilePathObj = {
    LTC: join(__dirname, 'litecoind'),
    // BTC: join(__dirname, 'bitcoind'),
};