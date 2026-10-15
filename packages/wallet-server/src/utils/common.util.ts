export const safeNumber = (a: number, d: number = 8) => parseFloat((a).toFixed(d));
// Decimal LTC amount to whole satoshis, rounded to the nearest satoshi.
export const toSats = (amount: number) => safeNumber(amount * 10 ** 8, 0);

// The one error reply of the local API: HTTP 500 with the error's message. A thrown string is
// sent as is; an Error object is not sent as its own JSON (which is {}).
export const sendError = (reply: { status(code: number): { send(body: unknown): unknown } }, error: any) =>
    reply.status(500).send({ error: (typeof error === 'string' ? error : error?.message) || 'Undefined Error' });
