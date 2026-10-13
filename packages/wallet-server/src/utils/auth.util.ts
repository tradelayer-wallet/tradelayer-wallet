import { timingSafeEqual } from "crypto";

// DNS-rebinding mitigation: only loopback Host headers are accepted. Parses
// the hostname properly instead of splitting on ':' (which mangled bracketed
// IPv6 like `[::1]:1986` into `[`), and normalizes case and the FQDN trailing
// dot so `Localhost`, `localhost.` and `LOCALHOST:1986` are accepted while
// any non-loopback host is rejected.
export const isLoopbackHostHeader = (host: unknown): boolean => {
    if (typeof host !== 'string' || !host) return false;
    let hostname = host.trim().toLowerCase();
    if (hostname.startsWith('[')) {
        // Bracketed IPv6: `[::1]` or `[::1]:1986`.
        const end = hostname.indexOf(']');
        if (end === -1) return false;
        hostname = hostname.slice(1, end);
    } else {
        // Hostname / IPv4, optionally with a `:port` suffix.
        hostname = hostname.replace(/:\d+$/, '');
    }
    // FQDN form: `localhost.` (and `localhost.:1986`).
    hostname = hostname.replace(/\.+$/, '');
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
