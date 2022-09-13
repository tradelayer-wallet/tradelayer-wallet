import { AES, enc } from 'crypto-js';

export const encrypt = (mnemonic: string, pass: string) => {
    return AES.encrypt(mnemonic, pass).toString();
}

export const decrypt = (key: string, pass: string) => {
    try {
        return AES.decrypt(key, pass)
            .toString(enc.Utf8);
    } catch(err) {
        return null;
    }
}