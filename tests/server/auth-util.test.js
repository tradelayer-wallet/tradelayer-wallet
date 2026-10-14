'use strict';

// Host and token checks of the local wallet server. These two checks guard every HTTP request
// and every socket.io handshake, so they are tested directly.

const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadTs, REPO } = require('../support/ts-loader');

const { isLoopbackHostHeader, authTokensMatch } = loadTs(
    path.join(REPO, 'packages', 'wallet-server', 'src', 'utils', 'auth.util.ts'),
).exports;

test('loopback Host headers are accepted', () => {
    for (const host of ['localhost', 'localhost:1986', 'LOCALHOST:1986', 'localhost.', 'localhost.:1986',
        '127.0.0.1', '127.0.0.1:1986', '[::1]', '[::1]:1986']) {
        assert.equal(isLoopbackHostHeader(host), true, host);
    }
});

test('any other Host header is refused, including DNS-rebinding and look-alike hosts', () => {
    for (const host of [undefined, null, '', 'attacker.example', 'attacker.example:1986',
        'localhost.attacker.example', 'localhost:evil', 'localhost..', '[::1]evil:1986', '[::1]:evil',
        '::1', 'localhost:1986:1', '127.0.0.1.nip.io', '0.0.0.0', '10.0.0.5:1986', ['localhost']]) {
        assert.equal(isLoopbackHostHeader(host), false, String(host));
    }
});

test('a token must match the session token exactly', () => {
    const expected = 'ab'.repeat(32);
    assert.equal(authTokensMatch(expected, expected), true);
    assert.equal(authTokensMatch('ab'.repeat(31) + 'ac', expected), false);
    assert.equal(authTokensMatch(expected.slice(1), expected), false);
    assert.equal(authTokensMatch(expected + 'x', expected), false);
});

test('a missing, non-string or empty token is refused, and no token is accepted when none was configured', () => {
    assert.equal(authTokensMatch(undefined, 'ab'.repeat(32)), false);
    assert.equal(authTokensMatch(['ab'.repeat(32)], 'ab'.repeat(32)), false);
    assert.equal(authTokensMatch('', ''), false);
    assert.equal(authTokensMatch('', 'ab'.repeat(32)), false);
    assert.equal(authTokensMatch('anything', ''), false);
});
