'use strict';

// The wallet window runs with Node integration, so it may show only files from the packaged
// app directory. Everything else is refused by isAllowedAppNavigation.

const path = require('path');
const { pathToFileURL } = require('url');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadTs, REPO } = require('../support/ts-loader');

const { isAllowedAppNavigation } = loadTs(path.join(REPO, 'builder', 'navigation-guard.ts')).exports;

const APP_INDEX = path.resolve('/opt/tl-wallet/fe/index.html');
const APP_DIR_URL = pathToFileURL(`${path.dirname(APP_INDEX)}${path.sep}`).href; // ends with '/'

test('the app index and files under the app directory may be navigated to', () => {
    assert.equal(isAllowedAppNavigation(pathToFileURL(APP_INDEX).href, APP_INDEX), true);
    assert.equal(isAllowedAppNavigation(`${APP_DIR_URL}assets/icons/x.svg`, APP_INDEX), true);
    assert.equal(isAllowedAppNavigation(`${APP_DIR_URL}index.html?x=1#/tx-builder`, APP_INDEX), true);
});

test('remote, script and other-scheme URLs are refused', () => {
    for (const url of ['https://evil.example/', 'http://localhost:1986/', 'javascript:alert(1)',
        'data:text/html,hi', 'about:blank', 'blob:file:///x', 'ftp://evil.example/x']) {
        assert.equal(isAllowedAppNavigation(url, APP_INDEX), false, url);
    }
});

test('file URLs outside the app directory are refused, including prefix look-alikes and traversal', () => {
    assert.equal(isAllowedAppNavigation('file:///etc/passwd', APP_INDEX), false);
    assert.equal(isAllowedAppNavigation('file:///opt/tl-wallet/fe2/index.html', APP_INDEX), false);
    assert.equal(isAllowedAppNavigation('file:///opt/tl-wallet/fe/../secret.html', APP_INDEX), false);
    assert.equal(isAllowedAppNavigation('file:///opt/tl-wallet/fe/%2e%2e/secret.html', APP_INDEX), false);
});

test('file URLs with a host are refused', () => {
    assert.equal(isAllowedAppNavigation('file://evil.example/opt/tl-wallet/fe/index.html', APP_INDEX), false);
});

test('malformed or empty URLs are refused', () => {
    assert.equal(isAllowedAppNavigation('', APP_INDEX), false);
    assert.equal(isAllowedAppNavigation('not a url', APP_INDEX), false);
});
