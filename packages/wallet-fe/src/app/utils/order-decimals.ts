// The orderbook server accepts an order amount or price only when it is a whole number of 1e-8
// units (at most 8 decimal places). Every outbound order is converted here, at the one place
// the order is emitted.
//
// Rounding is exact decimal arithmetic on the value's own decimal digits (not float math), so
// 0.1 + 0.2 becomes 0.3 and 0.123456789 becomes 0.12345678. The direction never lets an order ask
// for more than the user typed or holds:
//  - amount: always DOWN. A max BUY is available / price; rounding it up would cost more than the
//    balance. A SELL never sells more than the typed amount.
//  - price: a BUY pays at most the typed price (DOWN); a SELL receives at least the typed price (UP).
// A value that cannot be sent exactly (zero after rounding, not finite, negative, or beyond the
// safe integer range of 1e-8 units) throws, so no order is emitted with a changed meaning.

const UNIT_DIGITS = 8;
const SAFE_UNITS = Number.MAX_SAFE_INTEGER; // 9007199254740991

export type OrderAction = 'BUY' | 'SELL';

// The decimal digits of a finite positive number, from its 15-significant-digit form. That form
// drops binary noise (2.0999999999999996 reads as 2.1) and keeps every decimal a person types.
const decimalParts = (value: number): { int: string; frac: string } => {
    const [mantissa, exp = '0'] = value.toPrecision(15).split('e');
    const [intPart, fracPart = ''] = mantissa.split('.');
    const digits = intPart + fracPart;
    const point = intPart.length + Number(exp);
    if (point <= 0) return { int: '0', frac: '0'.repeat(-point) + digits };
    if (point >= digits.length) return { int: digits + '0'.repeat(point - digits.length), frac: '' };
    return { int: digits.slice(0, point), frac: digits.slice(point) };
};

// Units of 1e-8 for a value, rounded DOWN or UP. Throws if the result is not sendable.
const toUnits = (raw: number | string, roundUp: boolean, field: string): number => {
    const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${field} must be a positive number, got ${String(raw)}`);
    }
    const { int, frac } = decimalParts(value);
    const kept = (int + frac.slice(0, UNIT_DIGITS).padEnd(UNIT_DIGITS, '0')).replace(/^0+(?=\d)/, '');
    const dropped = frac.slice(UNIT_DIGITS);
    if (kept.length > String(SAFE_UNITS).length || Number(kept) > SAFE_UNITS) {
        throw new Error(`${field} is too large to send exactly`);
    }
    let units = Number(kept);
    if (roundUp && /[1-9]/.test(dropped)) units += 1;
    if (units <= 0) throw new Error(`${field} is smaller than 0.00000001 after rounding`);
    if (units > SAFE_UNITS) throw new Error(`${field} is too large to send exactly`);
    return units;
};

// Amount: always rounded down.
export const toOrderAmount = (value: number | string): number => toUnits(value, false, 'amount') / 1e8;

// Price: a BUY rounds down, a SELL rounds up, so the price never moves against the typed limit.
export const toOrderPrice = (value: number | string, action: OrderAction): number =>
    toUnits(value, action === 'SELL', 'price') / 1e8;

// Returns a copy of the order with amount and price on the server grid. The caller's object is
// not modified. Throws (before anything is emitted) if either value cannot be sent exactly.
export const withOrderDecimals = <T extends { action: OrderAction; props: { amount: any; price: any } }>(conf: T): T => ({
    ...conf,
    props: {
        ...conf.props,
        amount: toOrderAmount(conf.props.amount),
        price: toOrderPrice(conf.props.price, conf.action),
    },
});
