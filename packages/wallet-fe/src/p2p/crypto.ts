import { enc, SHA256 } from 'crypto-js';
import * as secp from '@noble/secp256k1';
import { stableStringify } from './canonical';
import type { OrderBodyV1, OrderEnvelopeV1 } from './types';

function hexToBytes(hex: string): Uint8Array {
  const s = String(hex || '').trim();
  if (s.length % 2 !== 0) throw new Error('hex length must be even');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

export function sha256Hex(input: string): string {
  return SHA256(input).toString(enc.Hex);
}

export function randomNonceHex(bytes: number = 16): string {
  const n = Math.max(16, Math.min(32, bytes));
  const a = new Uint8Array(n);
  // Prefer WebCrypto when available (Electron renderer).
  const c: any = (globalThis as any).crypto;
  if (c?.getRandomValues) c.getRandomValues(a);
  else {
    // Fallback: not cryptographically strong, but avoids hard failure in odd environments.
    for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0;
  }
  return Array.from(a)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function computeOrderId(body: OrderBodyV1, traderPubKey: string, clientNonce: string): string {
  const canonical = stableStringify(body);
  return sha256Hex(`${canonical}${traderPubKey}${clientNonce}`);
}

export async function signOrderIdWithPrivKeyHex(orderIdHex: string, privKeyHex: string): Promise<string> {
  const msg = hexToBytes(orderIdHex);
  if (msg.length !== 32) throw new Error('orderId must be 32-byte hex');
  const priv = hexToBytes(privKeyHex);
  if (priv.length !== 32) throw new Error('privKey must be 32-byte hex');

  // Return 64-byte compact (r||s), hex. Noble defaults to DER, so force `der:false`.
  const sig = await (secp as any).sign(msg, priv, { der: false } as any);
  if (!(sig instanceof Uint8Array) || sig.length !== 64) throw new Error('unexpected signature format');
  return bytesToHex(sig as Uint8Array);
}

export function verifyTraderSig(orderIdHex: string, sigHex: string, pubKeyHex: string): boolean {
  try {
    const msg = hexToBytes(orderIdHex);
    const sig = hexToBytes(sigHex);
    const pub = hexToBytes(pubKeyHex);
    if (msg.length !== 32) return false;
    if (sig.length !== 64) return false;
    // noble expects signature first.
    return secp.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

export function verifySig32(msg32Hex: string, sigHex: string, pubKeyHex: string): boolean {
  try {
    const msg = hexToBytes(msg32Hex);
    const sig = hexToBytes(sigHex);
    const pub = hexToBytes(pubKeyHex);
    if (msg.length !== 32) return false;
    if (sig.length !== 64) return false;
    return secp.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

export function buildEnvelope(
  kind: OrderEnvelopeV1['kind'],
  body: OrderBodyV1,
  traderPubKey: string,
  clientNonce: string,
  sigTrader: string,
  extra?: Partial<OrderEnvelopeV1>
): OrderEnvelopeV1 {
  const orderId = computeOrderId(body, traderPubKey, clientNonce);
  return {
    v: 1,
    kind,
    body,
    traderPubKey,
    clientNonce,
    orderId,
    sigTrader,
    ...(extra || {}),
  };
}
