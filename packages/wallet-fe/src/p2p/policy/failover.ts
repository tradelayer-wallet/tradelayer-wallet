import type { PeerTransportStatus } from '../PeerTransport';

export function pickPrimaryIndex(a: PeerTransportStatus, b: PeerTransportStatus): 0 | 1 {
  const ar = a.rttMs ?? 999999;
  const br = b.rttMs ?? 999999;
  return br < ar ? 1 : 0;
}

export function isDead(s: PeerTransportStatus, nowMs: number, deadAfterMs: number): boolean {
  if (!s.connected) return true;
  const lp = s.lastPongAtMs || 0;
  if (!lp) return false;
  return nowMs - lp > deadAfterMs;
}

