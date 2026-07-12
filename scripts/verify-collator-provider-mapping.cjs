#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');

const walletRoot = path.resolve(__dirname, '..');
const servicePath = path.join(walletRoot, 'packages', 'wallet-server', 'src', 'services', 'collator-peer.service.ts');
const listenerPath = process.env.TL_WALLET_LISTENER_SOURCE || 'C:\\projects\\tradelayer.js\\src\\walletListener.js';
const peerPath = process.env.TL_COLLATOR_PEER_SOURCE || 'C:\\projects\\tl-collator\\scripts\\fullnode-rpc-peer.cjs';

const service = fs.readFileSync(servicePath, 'utf8');
const listener = fs.readFileSync(listenerPath, 'utf8');
const peer = fs.readFileSync(peerPath, 'utf8');
const block = service.match(/export const ADVERTISED_PROVIDER_METHODS = \[([\s\S]*?)\n\] as const;/);
if (!block) throw new Error('Could not find ADVERTISED_PROVIDER_METHODS.');

const capabilities = [...block[1].matchAll(/\{ method: '([^']+)', listenerRoute: '([^']+)', httpMethod: '(GET|POST)' \}/g)]
  .map(([, method, listenerRoute, httpMethod]) => ({ method, listenerRoute, httpMethod }));
if (!capabilities.length) throw new Error('No advertised provider capabilities found.');

const prohibited = /(?:sign|privatekey|dumpprivkey|importprivkey|walletpassphrase|loadwallet|unloadwallet|finalizepsbt|sendrawtransaction|broadcast)/i;
for (const capability of capabilities) {
  if (prohibited.test(capability.method)) {
    throw new Error(`Prohibited provider method advertised: ${capability.method}`);
  }

  const route = new RegExp(`app\\.${capability.httpMethod.toLowerCase()}\\('${capability.listenerRoute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
  if (!route.test(listener)) {
    throw new Error(`${capability.method} declares missing listener route ${capability.httpMethod} ${capability.listenerRoute}`);
  }

  const adapter = new RegExp(`\\b${capability.method.toLowerCase()}:\\s*\\(\\)\\s*=>\\s*${capability.httpMethod.toLowerCase()}\\('${capability.listenerRoute.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
  const genericPayloadFallback = capability.method.startsWith('tl_createpayload_')
    && capability.httpMethod === 'POST'
    && peer.includes("return post(String(method).replace(/^\\/+/, ''), { params: req.params == null ? [] : req.params });");
  if (!adapter.test(peer) && !genericPayloadFallback) {
    throw new Error(`${capability.method} does not map to ${capability.httpMethod} ${capability.listenerRoute} in the WebRTC peer adapter`);
  }
}

for (const field of ['peers:', 'advertisedMethods:', 'retry:', 'lastSyncAt:', 'healthMonitorIntervalMs:', 'cleanExitRecoveryDelayMs:']) {
  if (!service.includes(field)) throw new Error(`Collator status is missing ${field}`);
}

console.log(JSON.stringify({
  ok: true,
  capabilityCount: capabilities.length,
  methods: capabilities.map(({ method }) => method),
  healthStatusFields: ['peers', 'advertisedMethods', 'retry', 'lastSyncAt', 'healthMonitorIntervalMs', 'cleanExitRecoveryDelayMs'],
}, null, 2));
