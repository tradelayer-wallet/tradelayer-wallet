import { appendFile } from "fs";
import { join } from "path"
import { defaultDirObj } from "../../conf/conf"

export const customLogger = (data: any) => {
    try {
        const path = defaultDirObj.WINDOWS
        const filePath = join(path, 'wallet-debug.log');
        appendFile(filePath, `${new Date().toISOString()}: ${data} \n`, (err) => {
            if (err) console.log(err);
        });
    } catch (err) {
        console.log(err);
    }
};
