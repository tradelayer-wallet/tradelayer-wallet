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

export const ENCODER = { encodeSend,encodeTradeTokensChannel };
