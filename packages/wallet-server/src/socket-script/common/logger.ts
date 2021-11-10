import { appendFile } from "fs";
import { join } from "path";
import { myWalletNode } from "../../services/wallet-node";

export const customLogger = (data: any) => {
    try {
        const path = myWalletNode.defaultPath;
        const filePath = join(path, 'wallet-debug.log');
        appendFile(filePath, `${new Date().toISOString()}: ${data} \n`, (err) => {
            if (err) console.log(err);
        });
    } catch (err) {
        console.log(err);
    }
};
