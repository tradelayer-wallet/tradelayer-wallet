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

export const ENCODER = { encodeSend };