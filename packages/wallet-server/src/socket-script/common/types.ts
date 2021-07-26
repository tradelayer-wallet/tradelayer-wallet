export interface ApiRes {
    data: any;
    error: string;
}

export interface ROptions {
    logs: boolean,
    send: boolean,
}

export interface TTTOptions {
    type: TradeTypes.TOKEN_TOKEN_TRADE,
    propertyid: number,
    amount: string,
    propertydesired: number,
    amountdesired: string,
    address: string,
    pubkey: string,
}

export interface LITOptions {
    type: TradeTypes.LTC_INSTANT_TRADE,
    propertyid: number,
    amount: number,
    price: number,
    address: string,
    pubkey: string,
}

export interface IRPCConenction {
    user: string,
    pass: string,
    host?: string,
    port?: number,
    ssl?: boolean,
    timeout?: number,
}

export interface IConnectionOptions {
    rpcConnection: IRPCConenction,
}

export interface IListenerOptions {
    address: string,
    logs: boolean,
}

export type Trade = LITOptions | TTTOptions;
export type TClient = (...args: any[]) => Promise<ApiRes>;

export enum Events1 {
    TRADE_REQUEST = 'TRADE_REQUEST',
    CHANNEL_PUB_KEY = 'CHANNEL_PUB_KEY',
    COMMIT_TO_CHANNEL = 'COMMIT_TO_CHANNEL',
    RAWTX_FOR_SIGNING = 'RAWTX_FOR_SIGNING',
}

export enum Events2 {
    REJECT_TRADE = 'REJECT_TRADE',
    TERMINATE_TRADE = 'TERMINATE_TRADE',
    CHANNEL_PUB_KEY = 'CHANNEL_PUB_KEY',
    MULTYSIG_DATA = 'MULTYSIG_DATA',
    COMMIT_TX = 'COMMIT_TX',
    SIGNED_RAWTX = 'SIGNED_RAWTX',
}

export enum TradeTypes {
    TOKEN_TOKEN_TRADE = 'TOKEN_TOKEN_TRADE',
    LTC_INSTANT_TRADE = 'LTC_INSTANT_TRADE',
} 