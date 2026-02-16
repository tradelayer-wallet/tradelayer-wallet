import * as assert from 'node:assert/strict';

import { stableStringify } from '../packages/wallet-fe/src/p2p/canonical';
import { computeOrderId, sha256Hex } from '../packages/wallet-fe/src/p2p/crypto';
import { TapeVerifier } from '../packages/wallet-fe/src/p2p/tape/TapeVerifier';
import { isDead, pickPrimaryIndex } from '../packages/wallet-fe/src/p2p/policy/failover';
import { pubkeyToBase58P2pkh, pubkeyMatchesBase58P2pkhAddress } from '../packages/wallet-fe/src/p2p/address';
import { verifyManifestInfraAttestationForClearlist } from '../packages/wallet-fe/src/p2p/infraAttestation';
import type { OrderBodyV1, TapeEntryV1 } from '../packages/wallet-fe/src/p2p/types';
import * as secp from '@noble/secp256k1';

function testStableStringify() {
  const a = { b: 2, a: 1, z: { d: 4, c: 3 } };
  const b = { z: { c: 3, d: 4 }, a: 1, b: 2 };
  assert.equal(stableStringify(a), stableStringify(b));
}

function testOrderIdDeterminism() {
  const bodyA: OrderBodyV1 = {
    v: 1,
    market: 'SPOT:LTC/USDT',
    side: 'BUY',
    px: '100',
    qty: '1.5',
    visibility: { kind: 'PUBLIC' },
    clientTs: 123,
  };
  const bodyB: any = {
    clientTs: 123,
    visibility: { kind: 'PUBLIC' },
    qty: '1.5',
    px: '100',
    side: 'BUY',
    market: 'SPOT:LTC/USDT',
    v: 1,
  };
  const pub = '02'.padEnd(66, '1');
  const nonce = 'aa'.repeat(16);
  assert.equal(computeOrderId(bodyA, pub, nonce), computeOrderId(bodyB, pub, nonce));
}

function testTapeVerifier() {
  const v = new TapeVerifier();

  const mkEntry = (seq: number, prevHash: string): TapeEntryV1 => {
    const orderBody: OrderBodyV1 = {
      v: 1,
      market: 'SPOT:LTC/USDT',
      side: 'BUY',
      px: '100',
      qty: '1',
      visibility: { kind: 'PUBLIC' },
      clientTs: 1,
    };
    const order = {
      v: 1,
      kind: 'NEW' as const,
      body: orderBody,
      traderPubKey: '02'.padEnd(66, '1'),
      clientNonce: 'bb'.repeat(16),
      orderId: sha256Hex('x' + seq),
      sigTrader: '00',
    };
    const base = {
      v: 1 as const,
      collatorId: 'c1',
      seq,
      prevHash,
      receivedTs: 1,
      order,
    };
    const entryHash = TapeVerifier.computeEntryHash(base);
    return { ...base, entryHash, sigCollator: '00' };
  };

  const e1 = mkEntry(1, '');
  assert.equal(v.verifyNext(e1).ok, true);
  const e2 = mkEntry(2, e1.entryHash);
  assert.equal(v.verifyNext(e2).ok, true);

  // bad prev hash
  const e3bad = mkEntry(3, 'deadbeef');
  assert.equal(v.verifyNext(e3bad).ok, false);
}

async function testInfraAttestationVerification() {
  // Deterministic admin key.
  const adminPriv = '11'.repeat(32);
  const adminPub = secp.getPublicKey(adminPriv, true);
  const adminPubHex = Buffer.from(adminPub).toString('hex');

  // Use BTC testnet p2pkh version (111) for the test vector.
  const adminAddr = pubkeyToBase58P2pkh(adminPubHex, 111);
  assert.equal(pubkeyMatchesBase58P2pkhAddress(adminPubHex, adminAddr), true);

  const collatorPub = '02'.padEnd(66, '2');
  const collatorId = sha256Hex(collatorPub);
  const ws = 'ws://127.0.0.1:8787/ws';
  const clearlistId = 42;

  const body: any = {
    v: 1,
    kind: 'COLLATOR_APPROVAL',
    clearlistId,
    infraPubKey: collatorPub,
    infraId: collatorId,
    ws,
    issuedAt: 1760000000,
    expiresAt: 1990000000,
    nonce: 'aa'.repeat(16),
    adminPubKey: adminPubHex,
  };

  const msg32Hex = sha256Hex(stableStringify(body));
  const sigBytes: Uint8Array = await (secp as any).sign(
    Buffer.from(msg32Hex, 'hex'),
    Buffer.from(adminPriv, 'hex'),
    { der: false } as any
  );
  assert.equal(sigBytes instanceof Uint8Array, true);
  assert.equal(sigBytes.length, 64);
  const sigHex = Buffer.from(sigBytes).toString('hex');

  const manifest: any = {
    v: 1,
    collatorId,
    collatorPubKey: collatorPub,
    roles: ['collator'],
    protocol: { wireMsgVersion: 1, dataChannelLabel: 'tl-bb', maxMsgBytes: 1048576 },
    tape: { format: 'ndjson', hash: 'sha256', indexStride: 1000, replayBatch: 500 },
    policy: {
      clearlist: { enforce: false, failMode: 'closed', cacheTtlSec: 60 },
      network: { ipLogging: 'off', vpnFilterMode: 'off', asnBlockMode: 'off' },
      rateLimit: { submitRps: 2, submitBurst: 10 },
    },
    build: { version: '0.0.0' },
    sigCollator: '00'.repeat(64),
    infraAttestations: [{ body, sigAdmin: sigHex }],
  };

  const ok = verifyManifestInfraAttestationForClearlist(manifest, ws, clearlistId, adminAddr);
  assert.equal(ok.ok, true);

  const badWs = verifyManifestInfraAttestationForClearlist(manifest, 'ws://127.0.0.1:9999/ws', clearlistId, adminAddr);
  assert.equal(badWs.ok, false);
}

async function main() {
  testStableStringify();
  testOrderIdDeterminism();
  testTapeVerifier();
  await testInfraAttestationVerification();

  // Failover helpers
  assert.equal(
    pickPrimaryIndex({ mode: 'P2P', connected: true, rttMs: 50 }, { mode: 'P2P', connected: true, rttMs: 10 }),
    1
  );
  assert.equal(isDead({ mode: 'P2P', connected: false }, Date.now(), 15000), true);
  assert.equal(isDead({ mode: 'P2P', connected: true, lastPongAtMs: Date.now() - 20000 }, Date.now(), 15000), true);
  assert.equal(isDead({ mode: 'P2P', connected: true, lastPongAtMs: Date.now() - 2000 }, Date.now(), 15000), false);

  // eslint-disable-next-line no-console
  console.log('p2p-tests: ok');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
