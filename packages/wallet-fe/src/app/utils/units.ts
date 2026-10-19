// Integer units on the wire (protocol-v2.md B.1, B.2). This module is the one place where a
// decimal number becomes units, units become an RPC string, a node float becomes satoshis, and
// units become a display number. Every other module calls these functions.

// 1e-8 of a whole asset: the satoshi for LTC, the base unit for a token and for a price in sats per
// whole token.
export const UNIT_SCALE = 100000000;

// The property id of LTC: 0, on the wire and in the wallet. It is the TradeLayer consensus id (LTC is
// the first cardinal) and the id the orderbook lists LTC under. Token ids start at 1, so 0 names no token.
export const LTC_PROPERTY_ID = 0;

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

// The largest amount at or below maxUnits whose value at priceUnits is a whole number of satoshis. The
// value is amount * price / UNIT_SCALE, so the amounts that settle are the multiples of
// UNIT_SCALE / gcd(price, UNIT_SCALE). Max uses this, so the order it fills is one valueSats accepts.
export const largestSettleableAmount = (maxUnits: number, priceUnits: number): number => {
    for (const units of [maxUnits, priceUnits]) {
        if (!isWireUnits(units)) throw new Error(`not a quantity in units: ${String(units)}`);
    }
    let gcd = priceUnits;
    let rest = UNIT_SCALE;
    while (rest) [gcd, rest] = [rest, gcd % rest];
    return maxUnits - (maxUnits % (UNIT_SCALE / gcd));
};

// Plain decimal text: digits with at most one point, as the extension's amount rule reads it. Anything
// else (hex, binary, octal, exponent, a sign, an embedded space) is refused, not converted.
const PLAIN_DECIMAL = /^(\d+\.?\d*|\.\d+)$/;

// The plain decimal text of a finite number, from its shortest round-trip form. That form is what a
// person typed (String(0.1 + 0.2) is "0.30000000000000004", String(5e-7) is "5e-7"), so an exponent form is
// expanded to the same digits: 5e-7 reads as 0.0000005. No binary rounding is applied to the digits.
const expandExponent = (text: string): string => {
    const [mantissa, exp] = text.split('e');
    if (exp === undefined) return text;
    const [intPart, fracPart = ''] = mantissa.split('.');
    const digits = intPart + fracPart;
    const point = intPart.length + Number(exp);
    if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
    if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
    return `${digits.slice(0, point)}.${digits.slice(point)}`;
};

// The typed value as plain decimal text. Throws when it is not a positive plain decimal.
const typedText = (raw: number | string, field: string): string => {
    const text = typeof raw === 'string'
        ? raw.trim()
        : Number.isFinite(raw) && raw > 0 ? expandExponent(String(raw)) : '';
    if (!PLAIN_DECIMAL.test(text) || !/[1-9]/.test(text)) {
        throw new Error(`${field} must be a positive number written in plain decimal, got ${String(raw)}`);
    }
    return text;
};

// Units of 1e-8 for a typed value, rounded down, or up when roundUp. Throws when the result cannot be
// sent exactly: not positive, not plain decimal, zero after rounding, or beyond the safe integer range.
const toUnitsFromInput = (raw: number | string, roundUp: boolean, field: string): number => {
    const [whole, places = ''] = typedText(raw, field).split('.');
    const kept = (whole + places.slice(0, 8).padEnd(8, '0')).replace(/^0+(?=\d)/, '');
    const dropped = places.slice(8);
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

// The futures leverage: a whole number of at least 1, written in plain decimal ("2.0" is 2).
export const toWireLeverage = (value: number | string): number => {
    const text = typeof value === 'string' ? value.trim() : Number.isFinite(value) ? expandExponent(String(value)) : '';
    const [whole, places = ''] = text.split('.');
    const n = Number(whole);
    if (!PLAIN_DECIMAL.test(text) || !/^0*$/.test(places) || !Number.isSafeInteger(n) || n < 1) {
        throw new Error(`leverage must be a whole number of at least 1, got ${String(value)}`);
    }
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

// Satoshis of an LTC amount a node or a PSBT reports as a float. The satoshis are read from the number's
// shortest decimal text, with the typed rule: a node writes at most 8 places, so a value with more places
// (0.1 + 0.2 is "0.30000000000000004") is refused, and a float is never scaled and rounded to one.
export const ltcToSats = (value: unknown, what = 'amount'): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`${what} is not a non-negative number`);
    }
    const [whole, places = ''] = expandExponent(String(value)).split('.');
    const sats = places.length > 8 ? NaN : Number(whole + places.padEnd(8, '0'));
    if (!isWireUnits(sats)) throw new Error(`${what} is not a whole number of satoshis`);
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
