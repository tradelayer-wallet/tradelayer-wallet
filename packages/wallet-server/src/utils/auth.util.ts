import { timingSafeEqual } from "crypto";

// DNS-rebinding mitigation: only loopback Host headers are accepted. Parses
// the hostname strictly instead of splitting on ':' (which mangled bracketed
// IPv6 like `[::1]:1986` into `[`), and normalizes case and one FQDN trailing
// dot so `Localhost`, `localhost.` and `LOCALHOST:1986` are accepted while
// any non-loopback host (or any extra characters around the port) is rejected.
export const isLoopbackHostHeader = (host: unknown): boolean => {
    if (typeof host !== 'string' || !host) return false;
    const value = host.trim().toLowerCase();
    let hostname: string;
    if (value.startsWith('[')) {
        // Bracketed IPv6: `[::1]` or `[::1]:1986`. Only nothing or a
        // `:<digits>` port may follow the closing bracket, so `[::1]evil:1986`
        // and `[::1]:evil` are rejected instead of silently ignored.
        const end = value.indexOf(']');
        if (end === -1) return false;
        const suffix = value.slice(end + 1);
        if (suffix !== '' && !/^:\d+$/.test(suffix)) return false;
        hostname = value.slice(1, end);
    } else {
        // Hostname / IPv4 with an optional `:<digits>` port; anything else
        // (`localhost:evil`, bare `::1`, `host:1:2`) is rejected.
        const match = /^([^:]*)(:\d+)?$/.exec(value);
        if (!match) return false;
        hostname = match[1];
    }
    // FQDN form: strip at most ONE trailing dot (`localhost.`, `localhost.:1986`
    // are accepted; `localhost..` is not).
    hostname = hostname.replace(/\.$/, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
};

// Compares a client-provided token with the expected per-session token in
// constant time. Returns false when no token was configured (fail closed).
export const authTokensMatch = (provided: unknown, expected: string): boolean => {
    if (typeof provided !== 'string' || !expected) return false;
    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);
    if (providedBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(providedBuf, expectedBuf);
};
