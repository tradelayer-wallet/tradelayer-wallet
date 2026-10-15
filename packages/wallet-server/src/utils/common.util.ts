export const safeNumber = (a: number, d: number = 8) => parseFloat((a).toFixed(d));
// Decimal LTC amount to whole satoshis, rounded to the nearest satoshi.
export const toSats = (amount: number) => safeNumber(amount * 10 ** 8, 0);
