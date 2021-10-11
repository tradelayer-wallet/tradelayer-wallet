import { homedir } from 'os';
import { join } from 'path';

export const defaultDirObj = `${homedir()}/AppData/Roaming/Litecoin`;
export const coreFilePathObj = join(__dirname, 'litecoind.exe');