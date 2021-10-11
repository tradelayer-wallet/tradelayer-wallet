import { homedir } from 'os';
import { join } from 'path';

export const defaultDirObj = `${homedir()}/Library/Application Support/Litecoin/`;
export const coreFilePathObj = join(__dirname, 'litecoind-mac');