// Wire name of every swap event, in both directions. The orderbook server routes
// by sessionId, never by socket, so there is no per-socket channel name.
export const SWAP_EVENT = 'swap';

// The single definition of a valid swap session id: the orderbook server issues
// 256 random bits as lowercase hex. Anything else is refused.
export const isSessionId = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// Bitcoin-family transaction id: 32 bytes as 64 hex characters.
export const isTxid = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);

// Decimal string of an amount for an RPC argument: at most 8 places, never exponent form.
// String(5e-7) is "5e-7", which the RPC does not take as an amount.
export const rpcAmount = (value: number): string => value.toFixed(8).replace(/\.?0+$/, '');

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
