import { appendFile } from "fs";
import { join } from "path";
import { defaultDirObj } from "../../conf/windows.conf";
const path = defaultDirObj;
export const customLogger = (data: any) => {
    try {
        const filePath = join(path, 'wallet-debug.log');
        appendFile(filePath, `${new Date().toISOString()}: ${data} \n`, (err) => {
            if (err) console.log(err);
        });
    } catch (err) {
        console.log(err);
    }
};
