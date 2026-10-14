import { IRpcResult, RpcClient } from 'tl-rpc';

// The one boundary where node RPC results become the values the wallet works with.
// tl-rpc may return an integer outside the JS safe range as a `bigint`. The wallet
// FE and this server do arithmetic on these fields and send them as JSON, and
// `JSON.stringify` throws on a bigint, so every bigint is converted here, to the
// `number` a plain JSON parse would have produced. (A decimal the double would
// round arrives as a string and is left as it is; the wallet reads those fields
// by name, see the report.)

const toWireValue = (value: unknown): unknown => {
    if (typeof value === 'bigint') return Number(value);
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

// The client the wallet constructs. Every call made through it, from the rpc-call
// route, the tx builder, the socket block counter or the stop path, is converted.
export class WireRpcClient extends RpcClient {
    async call(method: string, ...args: any[]): Promise<IRpcResult> {
        return toWireResult(await super.call(method, ...args));
    }
}
