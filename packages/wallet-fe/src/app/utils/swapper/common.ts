// Wire name of every swap event, in both directions. The orderbook server routes
// by sessionId, never by socket, so there is no per-socket channel name.
export const SWAP_EVENT = 'swap';

// The single definition of a valid swap session id: the orderbook server issues
// 256 random bits as lowercase hex. Anything else is refused.
export const isSessionId = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// Bitcoin-family transaction id: 32 bytes as 64 hex characters, lowercase on the wire.
export const isTxid = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// Negotiation must finish within this time. The server's SWAP_TIMEOUT_MS (120 s) is longer, so the
// wallet ends its own swap first. protocol-v2.md B.6.
export const NEGOTIATION_TIMEOUT_MS = 60000;
// After the seller's signature, the buyer may broadcast. The wallet waits this long for the server's
// verdict (protocol-v2.md B.6). It matches the server default.
export const SIGNED_WINDOW_MS = 600000;
// The reason text sent with TERMINATE_TRADE is bounded by the schema (256 characters).
export const MAX_REASON_LENGTH = 256;

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

// Trade props as they arrive: amounts and prices are integer units (protocol-v2.md B.1). The UI model
// holds the same fields as display numbers (protocol.ts toDisplayTrade).
export interface ISpotTradeProps {
    amountDesired: number;
    amountForSale: number;
    price: number;
    propIdDesired: number | string;
    propIdForSale: number | string;
};

export interface IFuturesTradeProps {
    amount: number;
    contract_id: number;
    price: number;
    levarage: number;
    collateral: number | string;
};

export interface IMSChannelData {
    address: string;
    redeemScript: string;
    scriptPubKey: string;
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
