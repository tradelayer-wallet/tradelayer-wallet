import * as litecore from 'litecore-lib';

export const generateRandomAddress = () => {
    const privKey = new litecore.PrivateKey();
    const address = privKey.toAddress();
    return { privKey, address }
};

export default {
    generateRandomAddress,
};