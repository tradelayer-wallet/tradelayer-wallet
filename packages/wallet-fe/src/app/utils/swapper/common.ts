// Wire name of every swap event, in both directions. The orderbook server routes
// by sessionId, never by socket, so there is no per-socket channel name.
export const SWAP_EVENT = 'swap';

export class SwapEvent {
    constructor(
        public sessionId: string,
        public eventName: string,
        public socketId: string,
        public data: any = null,
    ) {}
};

export enum ETradeType {
    SPOT = "SPOT",
    FUTURES = "FUTURES",
};

export type TClient = (method: string, ...args: any[]) => Promise<{
    data?: any;
    error?: string;
}>;

export interface ISpotTradeProps {
    amountDesired: number;
    amountForSale: number;
    propIdDesired: number;
    propIdForSale: number;
};

export interface IFuturesTradeProps {
    amount: number;
    contract_id: number;
    price: number;
    levarage: number;
    collateral: number;
};

export interface IMSChannelData {
    address: string;
    redeemScript: string;
    scriptPubKey?: string;
};

export interface IBuyerSellerKeyPair {
    address: string;
    pubkey: string;
};

export interface IBuyerSellerInfo {
    keypair: IBuyerSellerKeyPair;
    socketId: string;
};

export interface ITradeInfo<IProps = IFuturesTradeProps | ISpotTradeProps> {
    buyer: IBuyerSellerInfo;
    seller: IBuyerSellerInfo;
    taker: string;
    maker: string;
    props: IProps;
    type: ETradeType;
};
