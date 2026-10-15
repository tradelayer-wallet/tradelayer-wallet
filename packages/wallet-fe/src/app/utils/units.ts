// Integer units on the wire (protocol-v2.md B.1, B.2). This module is the one place where a
// decimal number becomes units, units become an RPC string, a node float becomes satoshis, and
// units become a display number. Every other module calls these functions.

// 1e-8 of a whole asset: the satoshi for LTC, the base unit for a token and for a price in sats per
// whole token.
export const UNIT_SCALE = 100000000;

export type TOrderAction = 'BUY' | 'SELL';

// A quantity on the wire: a safe integer, not negative. Positivity is a rule of each field.
export const isWireUnits = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// Decimal product of two non-negative integers given as digit strings (no BigInt: the same method
// as the orderbook server, so the two copies agree by construction and by the conformance vectors).
const mulDigitStrings = (x: string, y: string): string => {
    const xs = x.split('').reverse().map(Number);
    const ys = y.split('').reverse().map(Number);
    const out: number[] = [];
    for (let k = 0; k < xs.length + ys.length; k++) out.push(0);
    for (let i = 0; i < xs.length; i++) {
        for (let j = 0; j < ys.length; j++) out[i + j] += xs[i] * ys[j];
    }
    for (let k = 0; k < out.length - 1; k++) {
        out[k + 1] += Math.floor(out[k] / 10);
        out[k] = out[k] % 10;
    }
    return out.reverse().join('').replace(/^0+(?=\d)/, '');
};

// The satoshi value of a trade: amountUnits * priceSats / UNIT_SCALE, exact. Null when the quotient
// is not a whole number of satoshis or not a safe integer. Such a match is refused, never rounded.
export const valueSats = (amountUnits: number, priceSats: number): number | null => {
    if (!isWireUnits(amountUnits) || !isWireUnits(priceSats)) return null;
    const product = mulDigitStrings(String(amountUnits), String(priceSats));
    if (product === '0') return 0;
    if (product.length <= 8 || !/^0{8}$/.test(product.slice(-8))) return null;
    const quotient = Number(product.slice(0, -8));
    return Number.isSafeInteger(quotient) ? quotient : null;
};

// The decimal digits of a finite positive number, from its 15-significant-digit form. That form drops
// binary noise (2.0999999999999996 reads as 2.1) and keeps every decimal a person types.
const decimalParts = (value: number): { int: string; frac: string } => {
    const [mantissa, exp = '0'] = value.toPrecision(15).split('e');
    const [intPart, fracPart = ''] = mantissa.split('.');
    const digits = intPart + fracPart;
    const point = intPart.length + Number(exp);
    if (point <= 0) return { int: '0', frac: '0'.repeat(-point) + digits };
    if (point >= digits.length) return { int: digits + '0'.repeat(point - digits.length), frac: '' };
    return { int: digits.slice(0, point), frac: digits.slice(point) };
};

// Units of 1e-8 for a typed value, rounded down, or up when roundUp. Throws when the result cannot be
// sent exactly: not positive, not finite, zero after rounding, or beyond the safe integer range.
const toUnitsFromInput = (raw: number | string, roundUp: boolean, field: string): number => {
    const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${field} must be a positive number, got ${String(raw)}`);
    }
    const { int, frac } = decimalParts(value);
    const kept = (int + frac.slice(0, 8).padEnd(8, '0')).replace(/^0+(?=\d)/, '');
    const dropped = frac.slice(8);
    if (kept.length > String(Number.MAX_SAFE_INTEGER).length || Number(kept) > Number.MAX_SAFE_INTEGER) {
        throw new Error(`${field} is too large to send exactly`);
    }
    let units = Number(kept);
    if (roundUp && /[1-9]/.test(dropped)) units += 1;
    if (units <= 0) throw new Error(`${field} is smaller than 0.00000001 after rounding`);
    if (!isWireUnits(units)) throw new Error(`${field} is too large to send exactly`);
    return units;
};

// An amount of a token, in units: always rounded down, so an order never asks for more than was typed.
export const toWireAmount = (value: number | string, field = 'amount'): number => toUnitsFromInput(value, false, field);

// A price in sats per whole token: a BUY rounds down (pays at most the typed price), a SELL rounds up
// (receives at least the typed price).
export const toWirePrice = (value: number | string, action: TOrderAction): number =>
    toUnitsFromInput(value, action === 'SELL', 'price');

// The futures leverage: a whole number of at least 1.
export const toWireLeverage = (value: number | string): number => {
    const n = typeof value === 'string' ? Number(value.trim()) : value;
    if (!Number.isInteger(n) || n < 1) throw new Error(`leverage must be a whole number of at least 1, got ${String(value)}`);
    return n;
};

// The decimal string the TradeLayer RPC takes for a quantity in units: at most 8 places, never exponent
// form (String(5e-7) is "5e-7", which the RPC does not take). Exact, from the integer's digits.
export const unitsToDecimal = (units: number): string => {
    if (!isWireUnits(units)) throw new Error(`not a quantity in units: ${String(units)}`);
    const text = String(units);
    const digits = '0'.repeat(Math.max(0, 9 - text.length)) + text;
    const whole = digits.slice(0, -8);
    const frac = digits.slice(-8).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
};

// The display number of a quantity in units (token amount, price in LTC per token, or LTC). Used only
// where a value is shown or divided for display, never sent back.
export const unitsToNumber = (units: number): number => units / UNIT_SCALE;

// Satoshis of an LTC amount a node reports as a float. Refuses anything that is not a whole number
// of satoshis: the rounding error of a float is below 1e-6 satoshi, so a larger gap is not rounding.
const SAT_EPSILON = 1e-6;
export const ltcToSats = (value: unknown, what = 'amount'): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`${what} is not a non-negative number`);
    }
    const scaled = value * UNIT_SCALE;
    const sats = Math.round(scaled);
    if (!isWireUnits(sats) || Math.abs(scaled - sats) > SAT_EPSILON) {
        throw new Error(`${what} is not a whole number of satoshis`);
    }
    return sats;
};

// The LTC float a node or the local transaction builder takes for a satoshi amount.
export const satsToLtc = (sats: number): number => unitsToNumber(sats);

// The units of an order as it is emitted: amount, price, leverage and collateral (a property id, not
// an amount, so it is left as it is). The caller's object is not modified; a value that cannot be
// sent exactly throws before anything is emitted.
export const toWireOrder = <T extends { action: TOrderAction; props: { amount: any; price: any; levarage?: any } }>(conf: T): T => ({
    ...conf,
    props: {
        ...conf.props,
        amount: toWireAmount(conf.props.amount),
        price: toWirePrice(conf.props.price, conf.action),
        ...(conf.props.levarage !== undefined ? { levarage: toWireLeverage(conf.props.levarage) } : {}),
    },
});
