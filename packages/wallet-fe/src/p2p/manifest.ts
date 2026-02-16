import { stableStringify } from './canonical';
import { sha256Hex, verifySig32 } from './crypto';

export interface InfraAttestationBodyV1 {
  v: 1;
  kind: 'COLLATOR_APPROVAL' | 'BUNDLER_APPROVAL';
  clearlistId: number;
  infraPubKey: string;
  infraId: string;
  ws: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  adminPubKey: string;
}

export interface InfraAttestationV1 {
  body: InfraAttestationBodyV1;
  sigAdmin: string;
}

export interface CollatorManifestV1 {
  v: 1;
  collatorId: string;
  collatorPubKey: string;
  name?: string;
  operator?: string;
  region?: string;
  roles: Array<'collator' | 'bundler'>;
  protocol: { wireMsgVersion: 1; dataChannelLabel: string; maxMsgBytes: number };
  tape: { format: 'ndjson'; hash: 'sha256'; indexStride: number; replayBatch: number };
  policy: {
    clearlist: { enforce: boolean; failMode: 'open' | 'closed'; oracleUrl?: string; cacheTtlSec: number };
    network: { ipLogging: 'off' | 'on'; vpnFilterMode: 'off' | 'log' | 'reject'; asnBlockMode: 'off' | 'log' | 'reject' };
    rateLimit: { submitRps: number; submitBurst: number; connMax?: number };
  };
  build: { version: string; gitSha?: string; builtAt?: string };
  infraAttestations?: InfraAttestationV1[];
  sigCollator: string;
}

export interface ManifestVerifyResult {
  ok: boolean;
  reason?: string;
}

export function deriveCollatorId(pubKeyHex: string): string {
  return sha256Hex(pubKeyHex);
}

export function verifyManifest(m: CollatorManifestV1): ManifestVerifyResult {
  if (!m || m.v !== 1) return { ok: false, reason: 'bad version' };
  if (!m.collatorPubKey || !m.sigCollator) return { ok: false, reason: 'missing key/sig' };

  const expectedId = deriveCollatorId(String(m.collatorPubKey));
  if (String(m.collatorId) !== expectedId) return { ok: false, reason: 'collatorId mismatch' };

  const { sigCollator, ...body } = m as any;
  const msg32 = sha256Hex(stableStringify(body));
  const ok = verifySig32(msg32, String(sigCollator), String(m.collatorPubKey));
  return ok ? { ok: true } : { ok: false, reason: 'sig verify failed' };
}

export function manifestUrlFromWs(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/manifest';
  u.search = '';
  u.hash = '';
  return u.toString();
}
