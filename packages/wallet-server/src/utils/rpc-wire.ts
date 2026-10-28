import * as http from 'http';
import { IRpcClientOptions, IRpcResult, RpcClient } from 'tl-rpc';

// The one boundary where node RPC results become the values the wallet works with.
//
// JSON.parse rounds an integer literal beyond 2^53 to the nearest double without any error.
// tl-rpc's own call parses the response with JSON.parse, so a value such as 12345678901234567890
// would reach the wallet already changed. This client therefore makes the call itself and parses
// the response text so that such an integer arrives as its exact decimal string. Integers in the
// safe range, decimals and everything inside a string are unchanged.
//
// Consumers: a string integer is not a number. The wallet reads RPC amounts (listunspent,
// getMinVoutAmount, decoded vouts) as decimals with at most 8 places, which stay numbers, so no
// wallet arithmetic is done on an out-of-range integer today. Code that does arithmetic on an
// RPC integer field must check its type first.
//
// Written for the server's ES5 target: no BigInt in the source.

const SAFE_DIGITS = String(Number.MAX_SAFE_INTEGER); // "9007199254740991"

// True when an integer literal's digits (optional leading '-') are within the safe range.
const isSafeIntegerText = (text: string): boolean => {
    const digits = text.replace(/^-/, '').replace(/^0+(?=\d)/, '');
    if (digits.length !== SAFE_DIGITS.length) return digits.length < SAFE_DIGITS.length;
    return digits <= SAFE_DIGITS;
};

// A string literal or a number token, scanned left to right. A string is matched whole, so digits
// inside a string are never treated as numbers.
const STRING_OR_NUMBER = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

// JSON.parse, except that an integer literal outside the safe range is returned as its exact text.
export const parseRpcJson = (text: string): any => JSON.parse(
    text.replace(STRING_OR_NUMBER, (token: string) => (
        token.charAt(0) !== '"' && /^-?\d+$/.test(token) && !isSafeIntegerText(token) ? `"${token}"` : token
    )),
);

// Defensive: a bigint that reaches this point (not produced by the parser above) becomes its exact
// decimal string when it is outside the safe range, and a number otherwise.
const toWireValue = (value: unknown): unknown => {
    if (typeof value === 'bigint') {
        const text = value.toString();
        return isSafeIntegerText(text) ? Number(text) : text;
    }
    if (Array.isArray(value)) return value.map(toWireValue);
    if (value !== null && typeof value === 'object') {
        // defineProperty, not assignment: a key such as "__proto__" must stay an ordinary key.
        return Object.keys(value).reduce((out: object, key: string) => Object.defineProperty(out, key, {
            value: toWireValue((value as Record<string, unknown>)[key]),
            enumerable: true,
            writable: true,
            configurable: true,
        }), {});
    }
    return value;
};

export const toWireResult = (res: IRpcResult): IRpcResult => {
    if (!res || typeof res !== 'object' || !('data' in res)) return res;
    return { ...res, data: toWireValue(res.data) };
};

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

// The client the wallet constructs. Same contract and result shapes as tl-rpc's RpcClient.call
// (data, or error with IECode/EECode), with the lossless response parse above.
export class WireRpcClient extends RpcClient {
    private readonly wireOptions: IRpcClientOptions;

    constructor(options: IRpcClientOptions) {
        super(options);
        this.wireOptions = {
            username: 'root',
            password: 'passsword',
            host: 'localhost',
            port: 9332,
            timeout: 3000,
            ...options,
        };
    }

    async call(method: string, ...args: any[]): Promise<IRpcResult> {
        return toWireResult(await this.request(method, args));
    }

    private request(method: string, args: any[]): Promise<IRpcResult> {
        const { host, port, username, password, timeout } = this.wireOptions;
        const requestJSON = JSON.stringify({ id: Date.now(), method, params: args });
        return new Promise((resolve) => {
            const request = http.request({
                host,
                port,
                method: 'POST',
                headers: {
                    Host: 'localhost',
                    'Content-Length': Buffer.byteLength(requestJSON),
                },
                agent: false,
                auth: `${username}:${password}`,
            });
            // The timeout covers the whole exchange: it is cleared only when the body ends or the request fails.
            const timer = setTimeout(() => {
                request.destroy(); // a node that never answers, or stops mid-body, must not keep the socket open
                resolve({ error: 'ETIMEDOUT' });
            }, timeout);
            request.on('error', (error: Error) => {
                clearTimeout(timer);
                resolve({ error: error.message });
            });
            request.on('response', (response: http.IncomingMessage) => {
                let buffer = '';
                response.setEncoding('utf8');
                response.on('data', (chunk: string) => (buffer += chunk));
                response.on('end', () => {
                    clearTimeout(timer);
                    const { statusCode } = response;
                    try {
                        if (statusCode === 401) return resolve({ error: 'Unauthorized', statusCode, IECode: 4 });
                        const decRes = parseRpcJson(buffer);
                        if (hasOwn(decRes, 'error') && decRes.error !== null) {
                            return resolve({
                                error: decRes.error.message,
                                statusCode,
                                IECode: 2,
                                EECode: decRes.error.code || 0,
                            });
                        }
                        if (hasOwn(decRes, 'result')) return resolve({ data: decRes.result, statusCode });
                        return resolve({
                            error: decRes.error?.message || 'Undefined Error',
                            statusCode,
                            IECode: 3,
                            EECode: decRes.error?.code || 0,
                        });
                    } catch (error: any) {
                        statusCode !== 200
                            ? resolve({ error: error.message, statusCode })
                            : resolve({ error: error.message, statusCode, IECode: 1 });
                    }
                });
            });
            request.end(requestJSON);
        });
    }
}
