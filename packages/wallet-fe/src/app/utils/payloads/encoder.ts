const encodeSend = (params: { sendAll: boolean, address: string, propertyId: number | number[], amount: number | number[]}) => {
    if (params.sendAll)  return `1;${params.address}`;
    if (Array.isArray(params.propertyId) && Array.isArray(params.amount)) {
        const payload = [
            '0',
            '',
            params.propertyId.map(id => id.toString(36)).join(','),
            params.amount.map(amt => amt.toString(36)).join(',')
        ];
        return payload.join(';');
    } else {
        const payload = [
            '0',
            params.address,
            params.propertyId.toString(36),
            params.amount.toString(36)
        ];
        return 'tl2' + payload.join(';');
    }
};

type TradeTokensChannelParams = {
    propertyId1: number;
    propertyId2: number;
    amountOffered1: number;
    amountDesired2: number;
    columnAIsOfferer: boolean;
    expiryBlock: number;
};

const encodeTradeTokensChannel = (params: TradeTokensChannelParams): string => {
    const payload = [
        params.propertyId1.toString(36),
        params.propertyId2.toString(36),
        params.amountOffered1.toString(36),
        params.amountDesired2.toString(36),
        params.columnAIsOfferer ? '1' : '0',
        params.expiryBlock.toString(36),
    ];
    return payload.join(',');
};

type EncodeWithdrawalParams = {
    withdrawAll: boolean;
    propertyId: number;
    amount: number;
    column: number;
    channelAddress: string;
};

const encodeWithdrawal = (params: EncodeWithdrawalParams): string => {
    const withdrawAll = params.withdrawAll;
    const propertyIds = params.propertyId.toString(36);
    const amounts = params.amount.toString(36);
    const column = params.column; // 0 is A, 1 is B
    return [withdrawAll, propertyIds, amounts, column, params.channelAddress].join(',');
};

type EncodeTradeContractChannelParams = {
    contractId: number;
    price: number;
    amount: number;
    columnAIsSeller: boolean;
    expiryBlock: number;
    insurance: boolean;
};

const encodeTradeContractChannel = (params: EncodeTradeContractChannelParams): string => {
    const payload = [
        params.contractId.toString(36),
        params.price.toString(36),
        params.amount.toString(36),
        params.columnAIsSeller ? '1' : '0',
        params.expiryBlock.toString(36),
        params.insurance ? '1' : '0',
    ];
    return payload.join(',');
};

type EncodeTradeTokenForUTXOParams = {
    propertyId: number;
    amount: number;
    columnA: string;
    satsExpected: number;
    tokenOutput: string;
    payToAddress: string;
};

const encodeTradeTokenForUTXO = (params: EncodeTradeTokenForUTXOParams): string => {
    const payload = [
        params.propertyId.toString(36),
        params.amount.toString(36),
        params.columnA,
        params.satsExpected.toString(36),
        params.tokenOutput,
        params.payToAddress,
    ];
    return payload.join(',');
};

type EncodeCommitParams = {
    propertyId: number;
    amount: number;
    channelAddress: string;
};

const encodeCommit = (params: EncodeCommitParams): string => {
    const payload = [
        params.propertyId.toString(36),
        params.amount.toString(36),
        params.channelAddress,
    ];
    return payload.join(',');
};

export const ENCODER = { 
    encodeSend, 
    encodeTradeTokensChannel, 
    encodeWithdrawal, 
    encodeTradeContractChannel, 
    encodeTradeTokenForUTXO, 
    encodeCommit 
};
