import { ETradeType, ISpotTradeProps, ITradeInfo } from "./common";
import { valueSats } from "../units";

// The spot orders this wallet sent to the orderbook, as it sent them (wire units), and how much of each is
// still open. The orderbook's new-channel message names the trade, including this wallet's side, so a swap
// starts only when the trade fits one of these orders:
//   - this wallet's key pair on that side, the very address and pubkey the order was placed with;
//   - the order's side (a BUY order buys, a SELL order sells) and its token pair;
//   - a price no worse than the order's limit (a buy pays at most it, a sell receives at least it);
//   - an amount no larger than what is left of the order, and a value of exactly amount x price.
// The amount is reserved when the swap starts, so two swaps cannot fill one order twice over. It is given
// back if the swap aborts, and kept if the swap settled or its outcome could not be verified (it may have
// traded). The orderbook removes a socket's resting orders when the socket disconnects, so the ledger lives
// as long as the orderbook connection and is cleared with it.

export interface ILedgerOrder {
    keypair: { address: string; pubkey: string };
    action: 'BUY' | 'SELL';
    type: string;
    props: { id_desired: number | string; id_for_sale: number | string; amount: number; price: number };
}

export interface IReservation {
    readonly entry: object;
    readonly amount: number;
}

interface IEntry {
    order: ILedgerOrder;
    remaining: number;
}

// Whole wire units: a positive safe integer. Sums and comparisons of these are exact.
const wholeUnits = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

const sameKeyPair = (a: { address: string; pubkey: string }, b: { address: string; pubkey: string }): boolean =>
    a.address === b.address && typeof a.pubkey === 'string' && typeof b.pubkey === 'string'
        && a.pubkey.toLowerCase() === b.pubkey.toLowerCase();

export class OrderLedger {
    private entries: IEntry[] = [];

    // Records a spot order as it is sent. Anything else (futures, malformed units) is not recorded, so no
    // swap can start from it.
    record(order: ILedgerOrder): void {
        if (!order || order.type !== ETradeType.SPOT) return;
        if (order.action !== 'BUY' && order.action !== 'SELL') return;
        const amount = wholeUnits(order.props?.amount);
        if (amount === null || wholeUnits(order.props?.price) === null) return;
        this.entries.push({ order, remaining: amount });
    }

    // Forgets one open order that matches the given one (its key pair, side, pair and price), as on a cancel.
    forget(order: Pick<ILedgerOrder, 'keypair' | 'action' | 'props'>): void {
        const i = this.entries.findIndex((e) => e.order.action === order.action && sameKeyPair(e.order.keypair, order.keypair)
            && String(e.order.props.id_desired) === String(order.props.id_desired)
            && String(e.order.props.id_for_sale) === String(order.props.id_for_sale)
            && e.order.props.price === order.props.price);
        if (i >= 0) this.entries.splice(i, 1);
    }

    clear(): void {
        this.entries = [];
    }

    // The open amount of every recorded order, for tests and display.
    openAmounts(): number[] {
        return this.entries.map((e) => e.remaining);
    }

    // Reserves the trade's amount against an order it fits, or says why it fits none.
    reserve(tradeInfo: ITradeInfo, isBuyer: boolean): { reservation?: IReservation; error?: string } {
        if (tradeInfo.type !== ETradeType.SPOT) return { error: 'no spot order of this wallet: only spot orders are swapped' };
        const props = tradeInfo.props as ISpotTradeProps;
        const amount = wholeUnits(props.amountDesired);
        const price = wholeUnits(props.price);
        const value = wholeUnits(props.amountForSale);
        if (amount === null || price === null || value === null) return { error: 'the trade amounts are not whole units' };
        if (valueSats(amount, price) !== value) return { error: 'the trade value is not its amount at its price' };
        const mySide = isBuyer ? tradeInfo.buyer : tradeInfo.seller;
        const action = isBuyer ? 'BUY' : 'SELL';
        // The trade names the buyer's pair: it receives propIdDesired for propIdForSale. A seller's order sells
        // the token the buyer desires.
        const wantDesired = String(isBuyer ? props.propIdDesired : props.propIdForSale);
        const wantForSale = String(isBuyer ? props.propIdForSale : props.propIdDesired);
        const entry = this.entries.find((e) => e.order.action === action
            && sameKeyPair(e.order.keypair, mySide.keypair)
            && String(e.order.props.id_desired) === wantDesired
            && String(e.order.props.id_for_sale) === wantForSale
            && (isBuyer ? price <= e.order.props.price : price >= e.order.props.price)
            && amount <= e.remaining);
        if (!entry) return { error: 'the trade does not fit an open order this wallet placed' };
        entry.remaining -= amount;
        return { reservation: { entry, amount } };
    }

    // Gives a reserved amount back, after a swap that aborted. An order cleared meanwhile stays cleared.
    release(reservation: IReservation): void {
        const entry = this.entries.find((e) => e === reservation.entry);
        if (entry) entry.remaining += reservation.amount;
    }
}
