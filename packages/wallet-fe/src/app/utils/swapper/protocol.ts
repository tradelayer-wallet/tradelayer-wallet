// Every message the wallet receives from the orderbook server is checked here, once, at the socket
// boundary (protocol-v2.md B.3). Each parser returns the cleaned value: only the declared fields
// survive, and the swap, the order services and the UI use the result without checking it again.
// Amounts are integer units on the wire. The display converters at the end turn them into numbers
// for the UI, and nothing sends a display number back.

import { isWireUnits, unitsToNumber, valueSats } from '../units';
import {
    ETradeType, IBuyerSellerInfo, IFuturesTradeProps, IMSChannelData, ISpotTradeProps, ITradeInfo, isSessionId, isTxid,
} from './common';

export type TResult<T> = { data?: T; error?: string };
const fail = (error: string): TResult<never> => ({ error });
const ok = <T>(data: T): TResult<T> => ({ data });

const SCHEMA_ERROR = 'does not match its schema';
const isObject = (value: unknown): value is Record<string, any> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max;
const isPositiveUnits = (value: unknown): value is number => isWireUnits(value) && value > 0;
const isHex = (value: unknown, maxChars: number): value is string =>
    typeof value === 'string' && value.length <= maxChars && /^([0-9a-f]{2})+$/.test(value);
// A market id: a non-negative integer, or a synthetic id such as "s-1-5".
const isMarketId = (value: unknown): value is number | string =>
    isWireUnits(value) || (typeof value === 'string' && value.length <= 32 && /^s-\d+-\d+$/.test(value));

// ---- trades ---------------------------------------------------------------------

const parseKeypair = (raw: unknown): TResult<{ address: string; pubkey: string }> =>
    isObject(raw) && isText(raw.address, 256) && isText(raw.pubkey, 256)
        ? ok({ address: raw.address, pubkey: raw.pubkey })
        : fail(`keypair ${SCHEMA_ERROR}`);

const parseParty = (raw: unknown): TResult<IBuyerSellerInfo> => {
    if (!isObject(raw) || !isText(raw.socketId, 64)) return fail(`party ${SCHEMA_ERROR}`);
    const keypair = parseKeypair(raw.keypair);
    return keypair.data ? ok({ socketId: raw.socketId, keypair: keypair.data }) : fail(keypair.error || SCHEMA_ERROR);
};

const parseSpotProps = (raw: Record<string, any>): TResult<ISpotTradeProps> => {
    const { propIdDesired, propIdForSale, amountDesired, amountForSale, price } = raw;
    if (!isMarketId(propIdDesired) || !isMarketId(propIdForSale)) return fail(`trade props ${SCHEMA_ERROR}`);
    if (!isPositiveUnits(amountDesired) || !isPositiveUnits(amountForSale) || !isPositiveUnits(price)) {
        return fail(`trade props ${SCHEMA_ERROR}`);
    }
    // The value is checked against the price, so a trade whose two numbers disagree is refused.
    if (valueSats(amountDesired, price) !== amountForSale) return fail('trade value does not equal amount times price');
    return ok({ propIdDesired, propIdForSale, amountDesired, amountForSale, price });
};

const parseFuturesProps = (raw: Record<string, any>): TResult<IFuturesTradeProps> => {
    const { contract_id, amount, price, levarage, collateral } = raw;
    if (!isWireUnits(contract_id) || !isPositiveUnits(amount) || !isPositiveUnits(price)) return fail(`trade props ${SCHEMA_ERROR}`);
    if (!isWireUnits(levarage) || levarage < 1 || !isMarketId(collateral)) return fail(`trade props ${SCHEMA_ERROR}`);
    return ok({ contract_id, amount, price, levarage, collateral });
};

export const parseTrade = (raw: unknown): TResult<ITradeInfo> => {
    if (!isObject(raw)) return fail(`trade ${SCHEMA_ERROR}`);
    const buyer = parseParty(raw.buyer);
    const seller = parseParty(raw.seller);
    if (!buyer.data || !seller.data) return fail(buyer.error || seller.error || SCHEMA_ERROR);
    if (!isText(raw.taker, 64) || !isText(raw.maker, 64) || !isObject(raw.props)) return fail(`trade ${SCHEMA_ERROR}`);
    const base = { buyer: buyer.data, seller: seller.data, taker: raw.taker, maker: raw.maker };
    if (raw.type === ETradeType.SPOT) {
        const props = parseSpotProps(raw.props);
        return props.data ? ok({ ...base, type: ETradeType.SPOT, props: props.data }) : fail(props.error || SCHEMA_ERROR);
    }
    if (raw.type === ETradeType.FUTURES) {
        const props = parseFuturesProps(raw.props);
        return props.data ? ok({ ...base, type: ETradeType.FUTURES, props: props.data }) : fail(props.error || SCHEMA_ERROR);
    }
    return fail(`trade type ${SCHEMA_ERROR}`);
};

// ---- orders and the book ----------------------------------------------------------

export interface IWireOrder {
    type: ETradeType;
    action: 'BUY' | 'SELL';
    isLimitOrder: true;
    marketName: string;
    keypair: { address: string; pubkey: string };
    props: Record<string, any>;
    uuid: string;
    timestamp: number;
    socket_id: string;
    lock: boolean;
    state?: 'CANCALED' | 'FILLED';
}

const parseOrder = (raw: unknown): TResult<IWireOrder> => {
    if (!isObject(raw)) return fail(`order ${SCHEMA_ERROR}`);
    const keypair = parseKeypair(raw.keypair);
    if (!keypair.data) return fail(keypair.error || SCHEMA_ERROR);
    if ((raw.action !== 'BUY' && raw.action !== 'SELL') || raw.isLimitOrder !== true) return fail(`order ${SCHEMA_ERROR}`);
    if (!isText(raw.marketName, 256) || !isText(raw.uuid, 64) || !Number.isSafeInteger(raw.timestamp)) return fail(`order ${SCHEMA_ERROR}`);
    if (!isText(raw.socket_id, 64) || typeof raw.lock !== 'boolean' || !isObject(raw.props)) return fail(`order ${SCHEMA_ERROR}`);
    if (raw.state !== undefined && raw.state !== 'CANCALED' && raw.state !== 'FILLED') return fail(`order ${SCHEMA_ERROR}`);
    const p = raw.props;
    let props: Record<string, any>;
    if (raw.type === ETradeType.SPOT) {
        if (!isMarketId(p.id_for_sale) || !isMarketId(p.id_desired) || !isPositiveUnits(p.amount) || !isPositiveUnits(p.price)) {
            return fail(`order ${SCHEMA_ERROR}`);
        }
        props = { id_for_sale: p.id_for_sale, id_desired: p.id_desired, amount: p.amount, price: p.price };
    } else if (raw.type === ETradeType.FUTURES) {
        if (!isWireUnits(p.contract_id) || !isPositiveUnits(p.amount) || !isPositiveUnits(p.price)) return fail(`order ${SCHEMA_ERROR}`);
        if (!isWireUnits(p.levarage) || p.levarage < 1 || !isMarketId(p.collateral)) return fail(`order ${SCHEMA_ERROR}`);
        props = { contract_id: p.contract_id, amount: p.amount, price: p.price, levarage: p.levarage, collateral: p.collateral };
    } else {
        return fail(`order ${SCHEMA_ERROR}`);
    }
    const order: IWireOrder = {
        type: raw.type, action: raw.action, isLimitOrder: true, marketName: raw.marketName, keypair: keypair.data,
        props, uuid: raw.uuid, timestamp: raw.timestamp, socket_id: raw.socket_id, lock: raw.lock,
    };
    if (raw.state !== undefined) order.state = raw.state;
    return ok(order);
};

export interface IWireHistoryTrade extends ITradeInfo {
    txid: string;
    time: number;
}

// orderbook-data: the book and the trades of one market.
export const parseOrderbookData = (raw: unknown): TResult<{ orders: IWireOrder[]; history: IWireHistoryTrade[] }> => {
    if (!isObject(raw) || !Array.isArray(raw.orders) || !Array.isArray(raw.history)) return fail(`orderbook-data ${SCHEMA_ERROR}`);
    const orders: IWireOrder[] = [];
    for (const o of raw.orders) {
        const parsed = parseOrder(o);
        if (!parsed.data) return fail(parsed.error || SCHEMA_ERROR);
        orders.push(parsed.data);
    }
    const history: IWireHistoryTrade[] = [];
    for (const h of raw.history) {
        const trade = parseTrade(h);
        if (!trade.data || !isTxid(h.txid) || !Number.isSafeInteger(h.time)) return fail(trade.error || `history ${SCHEMA_ERROR}`);
        history.push({ ...trade.data, txid: h.txid, time: h.time });
    }
    return ok({ orders, history });
};

// Display form: amounts and prices as numbers, for the UI only. Ids and flags are unchanged.
export const toDisplayOrder = (order: IWireOrder): IWireOrder => ({
    ...order,
    props: { ...order.props, amount: unitsToNumber(order.props.amount), price: unitsToNumber(order.props.price) },
});

const displayTradeProps = (props: ISpotTradeProps | IFuturesTradeProps): any => ('amountDesired' in props
    ? {
        ...props,
        amountDesired: unitsToNumber(props.amountDesired),
        amountForSale: unitsToNumber(props.amountForSale),
        price: unitsToNumber(props.price),
    }
    : { ...props, amount: unitsToNumber(props.amount), price: unitsToNumber(props.price) });

export const toDisplayTrade = <T extends ITradeInfo>(trade: T): T => ({ ...trade, props: displayTradeProps(trade.props) });

// ---- swap channel --------------------------------------------------------------------

export interface IChannelSwapData {
    sessionId: string;
    isBuyer: boolean;
    tradeInfo: ITradeInfo;
}

// new-channel: the server's offer of a swap to one participant.
export const parseNewChannel = (raw: unknown): TResult<IChannelSwapData> => {
    if (!isObject(raw) || !isSessionId(raw.sessionId) || typeof raw.isBuyer !== 'boolean') return fail(`new-channel ${SCHEMA_ERROR}`);
    const trade = parseTrade(raw.tradeInfo);
    return trade.data ? ok({ sessionId: raw.sessionId, isBuyer: raw.isBuyer, tradeInfo: trade.data }) : fail(trade.error || SCHEMA_ERROR);
};

// The data of each negotiation step, by eventName (the server's step table, protocol-v2.md B.3.5).
const parseMsData = (data: unknown): TResult<IMSChannelData> => {
    if (!isObject(data) || !isText(data.address, 128) || !isHex(data.redeemScript, 4096) || !isHex(data.scriptPubKey, 128)) {
        return fail(SCHEMA_ERROR);
    }
    return ok({ address: data.address, redeemScript: data.redeemScript, scriptPubKey: data.scriptPubKey });
};

export interface ICommitUtxo {
    txid: string;
    vout: number;
    sats: number;
    scriptPubKey: string;
    redeemScript: string;
}

const parseCommitUtxo = (data: unknown): TResult<ICommitUtxo> => {
    if (!isObject(data) || !isTxid(data.txid) || !isWireUnits(data.vout) || data.vout > 0xffffffff) return fail(SCHEMA_ERROR);
    if (!isPositiveUnits(data.sats) || !isHex(data.scriptPubKey, 128) || !isHex(data.redeemScript, 4096)) return fail(SCHEMA_ERROR);
    return ok({ txid: data.txid, vout: data.vout, sats: data.sats, scriptPubKey: data.scriptPubKey, redeemScript: data.redeemScript });
};

const parsePsbt = (data: unknown): TResult<string> => (isHex(data, 500000) ? ok(data) : fail(SCHEMA_ERROR));
const parseTxidData = (data: unknown): TResult<string> => (isTxid(data) && data === data.toLowerCase() ? ok(data) : fail(SCHEMA_ERROR));
const parseNoData = (data: unknown): TResult<null> => (data === undefined || data === null ? ok(null) : fail(SCHEMA_ERROR));
const parseReason = (data: unknown): TResult<string | null> => {
    if (data === undefined || data === null) return ok(null);
    return isText(data, 256) ? ok(data) : fail(SCHEMA_ERROR);
};
const parseServerState = (data: unknown): TResult<{ state: 'settled' | 'aborted' | 'expired-unverified'; txid: string | null }> => {
    if (!isObject(data) || (data.state !== 'settled' && data.state !== 'aborted' && data.state !== 'expired-unverified')) return fail(SCHEMA_ERROR);
    if (data.txid !== null && !isTxid(data.txid)) return fail(SCHEMA_ERROR);
    return ok({ state: data.state, txid: data.txid });
};

export type TSwapEventData = {
    'SELLER:STEP1': IMSChannelData;
    'BUYER:STEP2': null;
    'SELLER:STEP3': ICommitUtxo;
    'BUYER:STEP4': string;
    'SELLER:STEP5': string;
    'BUYER:STEP6': string;
    'TERMINATE_TRADE': string | null;
    'SERVER:STATE': { state: 'settled' | 'aborted' | 'expired-unverified'; txid: string | null };
};
export type TSwapEventName = keyof TSwapEventData;

const STEP_PARSERS: { [K in TSwapEventName]: (data: unknown) => TResult<TSwapEventData[K]> } = {
    'SELLER:STEP1': parseMsData,
    'BUYER:STEP2': parseNoData,
    'SELLER:STEP3': parseCommitUtxo,
    'BUYER:STEP4': parsePsbt,
    'SELLER:STEP5': parsePsbt,
    'BUYER:STEP6': parseTxidData,
    'TERMINATE_TRADE': parseReason,
    'SERVER:STATE': parseServerState,
};

export interface ISwapRelay<K extends TSwapEventName = TSwapEventName> {
    sessionId: string;
    eventName: K;
    socketId: string | null;
    data: TSwapEventData[K];
}

// swap, server to wallet: a relayed step, a termination, or the server's terminal-state notice.
export const parseSwapRelay = (raw: unknown): TResult<ISwapRelay> => {
    if (!isObject(raw) || !isSessionId(raw.sessionId) || typeof raw.eventName !== 'string') return fail(`swap event ${SCHEMA_ERROR}`);
    if (!Object.prototype.hasOwnProperty.call(STEP_PARSERS, raw.eventName)) return fail(`swap event ${SCHEMA_ERROR}`);
    const eventName = raw.eventName as TSwapEventName;
    const socketId = raw.socketId === null && eventName === 'SERVER:STATE' ? null : raw.socketId;
    if (eventName !== 'SERVER:STATE' && !isText(socketId, 64)) return fail(`swap event ${SCHEMA_ERROR}`);
    const data = STEP_PARSERS[eventName](raw.data);
    if (data.error) return fail(`${eventName} data ${SCHEMA_ERROR}`);
    return ok({ sessionId: raw.sessionId, eventName, socketId: socketId as string | null, data: data.data as any });
};
