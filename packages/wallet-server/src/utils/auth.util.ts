import { timingSafeEqual } from "crypto";

// Compares a client-provided token with the expected per-session token in
// constant time. Returns false when no token was configured (fail closed).
export const authTokensMatch = (provided: unknown, expected: string): boolean => {
    if (typeof provided !== 'string' || !expected) return false;
    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);
    if (providedBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(providedBuf, expectedBuf);
};
