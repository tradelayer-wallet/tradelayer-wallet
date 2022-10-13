export class SwapEvent {
    constructor(
        public eventName: string,
        public socketId: string,
        public data: any = null,
    ) {}
}

export type TClient = (method: string, ...args: any[]) => Promise<{
    data?: any;
    error?: string;
}>;

export interface ITradeInfo {
    amountDesired: number;
    amountForSale: number;
    propIdDesired: number;
    propIdForSale: number;
}

export interface IMSChannelData {
    address: string;
    redeemScript: string;
    scriptPubKey?: string;
}

export interface TBuyerSellerInfo {
    address: string;
    pubKey: string;
    socketId: string;
}
