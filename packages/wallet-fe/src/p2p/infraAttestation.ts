import { stableStringify } from './canonical';
import { sha256Hex, verifySig32 } from './crypto';
import { pubkeyMatchesBase58P2pkhAddress } from './address';
import { deriveCollatorId } from './manifest';
import type { CollatorManifestV1 } from './manifest';

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
  sigAdmin: string; // compact 64-byte, hex
}

export interface InfraAttestationVerifyResult {
  ok: boolean;
  reason?: string;
  clearlistId?: number;
  adminAddress?: string;
  expiresAt?: number;
  issuedAt?: number;
}

function normalizeWsUrl(u: string): string | null {
  try {
    const url = new URL(String(u || '').trim());
    url.hash = '';
    // Keep path; /ws matters. Strip trailing slash for stable compare.
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return null;
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function verifyInfraAttestationBodySig(body: InfraAttestationBodyV1, sigAdminHex: string): boolean {
  if (!body || body.v !== 1) return false;
  if (typeof sigAdminHex !== 'string' || !/^[0-9a-fA-F]{128}$/.test(sigAdminHex)) return false;
  if (typeof body.adminPubKey !== 'string' || !/^[0-9a-fA-F]+$/.test(body.adminPubKey)) return false;
  const msg32 = sha256Hex(stableStringify(body));
  return verifySig32(msg32, sigAdminHex, body.adminPubKey);
}

export function verifyManifestInfraAttestationForClearlist(
  manifest: CollatorManifestV1,
  connectedWsUrl: string,
  clearlistId: number,
  protocolAdminAddress: string
): InfraAttestationVerifyResult {
  const wsNorm = normalizeWsUrl(connectedWsUrl);
  if (!wsNorm) return { ok: false, reason: 'bad_ws_url' };
  if (!manifest) return { ok: false, reason: 'missing_manifest' };

  const atts = (manifest as any).infraAttestations as InfraAttestationV1[] | undefined;
  if (!Array.isArray(atts) || !atts.length) return { ok: false, reason: 'no_attestations' };

  const wantInfraPub = String(manifest.collatorPubKey || '');
  const wantInfraId = String(manifest.collatorId || '');
  const derivedId = deriveCollatorId(wantInfraPub);
  if (wantInfraId !== derivedId) return { ok: false, reason: 'manifest_collatorId_invalid' };

  let best: InfraAttestationVerifyResult | null = null;
  const now = nowSec();

  for (const a of atts) {
    const body = a?.body as any;
    const sigAdmin = a?.sigAdmin;
    if (!body || body.v !== 1) continue;
    if (body.kind !== 'COLLATOR_APPROVAL') continue;
    if (Number(body.clearlistId) !== Number(clearlistId)) continue;

    const attWsNorm = normalizeWsUrl(String(body.ws || ''));
    if (!attWsNorm || attWsNorm !== wsNorm) continue;

    const infraPubKey = String(body.infraPubKey || '');
    const infraId = String(body.infraId || '');
    if (!infraPubKey || infraPubKey !== wantInfraPub) continue;
    if (!infraId || infraId !== wantInfraId) continue;

    const exp = Number(body.expiresAt);
    const iss = Number(body.issuedAt);
    if (!Number.isFinite(exp) || exp <= 0) continue;
    if (exp < now) continue;
    if (!Number.isFinite(iss) || iss <= 0) continue;

    const adminPubKey = String(body.adminPubKey || '');
    if (!pubkeyMatchesBase58P2pkhAddress(adminPubKey, protocolAdminAddress)) continue;

    if (!verifyInfraAttestationBodySig(body, String(sigAdmin || ''))) continue;

    const candidate: InfraAttestationVerifyResult = {
      ok: true,
      clearlistId,
      adminAddress: protocolAdminAddress,
      expiresAt: exp,
      issuedAt: iss,
    };

    // Prefer the attestation with the furthest expiry.
    if (!best || (candidate.expiresAt || 0) > (best.expiresAt || 0)) best = candidate;
  }

  return best || { ok: false, reason: 'no_valid_attestation' };
}

