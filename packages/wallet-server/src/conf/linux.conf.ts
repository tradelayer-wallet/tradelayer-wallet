import { homedir } from 'os';
import { join } from 'path';

export const defaultDirObj = `${homedir()}/.litecoin/`;
export const coreFilePathObj = join(__dirname, 'litecoind');