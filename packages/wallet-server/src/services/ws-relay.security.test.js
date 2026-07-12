/* eslint-disable no-console */
const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'ws-relay.service.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(compiled, sourcePath);

const {
  getRelaySecurityConfig,
  isRelayOriginAllowed,
  isRelayRouteAllowed,
  validateRelayRequest,
} = loaded.exports;

assert.throws(
  () => getRelaySecurityConfig({ NODE_ENV: 'production' }),
  /TL_WS_RELAY_TOKEN is required/
);
assert.deepStrictEqual(getRelaySecurityConfig({
  NODE_ENV: 'production',
  TL_WS_RELAY_TOKEN: 'launch-secret',
  TL_WS_RELAY_ALLOWED_ORIGINS: 'https://testnet.example.org',
}), {
  authenticationRequired: true,
  token: 'launch-secret',
  allowedOrigins: ['https://testnet.example.org'],
});
assert.strictEqual(
  getRelaySecurityConfig({ NODE_ENV: 'development', TL_WS_RELAY_ALLOW_INSECURE_DEV: '1' }).authenticationRequired,
  false
);

assert.strictEqual(isRelayRouteAllowed('GET', '/api/tradelayer/sync-status'), true);
assert.strictEqual(isRelayRouteAllowed('POST', '/rpc/tl_createpayload_simplesend'), true);
assert.strictEqual(isRelayRouteAllowed('POST', '/rpc/dumpprivkey'), false);
assert.strictEqual(isRelayRouteAllowed('POST', '/api/sign-tx'), false);
assert.strictEqual(isRelayOriginAllowed('https://wallet.example.org', 'wallet.example.org', []), true);
assert.strictEqual(isRelayOriginAllowed('https://evil.example.org', 'wallet.example.org', []), false);
assert.strictEqual(isRelayOriginAllowed('https://wallet.example.org', 'wallet.example.org', ['https://wallet.example.org']), true);

assert.deepStrictEqual(validateRelayRequest({
  method: 'POST',
  path: '/rpc/tl_createpayload_simplesend',
  body: { params: [{ address: 'tltc1example', propertyId: 1, amount: 1 }] },
  headers: { accept: 'application/json' },
}, '/'), {
  method: 'POST',
  targetPath: '/rpc/tl_createpayload_simplesend',
  headers: { accept: 'application/json' },
});
assert.throws(
  () => validateRelayRequest({
    method: 'POST',
    path: '/rpc/dumpprivkey',
    body: { params: [] },
  }, '/'),
  /not allowed/
);
assert.throws(
  () => validateRelayRequest({
    method: 'POST',
    path: '/rpc/tl_createpayload_simplesend',
    body: { params: [] },
    headers: { 'x-tradelayer-internal-relay': '0' },
  }, '/'),
  /unsafe header override/
);
assert.throws(
  () => validateRelayRequest({
    method: 'POST',
    path: '/rpc/tl_createpayload_simplesend',
    query: { bypass: '1' },
    body: { params: [] },
  }, '/'),
  /query parameters are not allowed/
);

console.log('ws-relay security checks passed');
