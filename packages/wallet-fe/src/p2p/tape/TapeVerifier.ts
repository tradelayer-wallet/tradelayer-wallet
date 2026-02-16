import { sha256Hex, verifySig32 } from '../crypto';
import { stableStringify } from '../canonical';
import type { TapeEntryV1 } from '../types';

export interface TapeVerifyResult {
  ok: boolean;
  error?: string;
  duplicate?: boolean;
}

export class TapeVerifier {
  private lastSeq: number | null = null;
  private lastHash: string | null = null;

  // Collator-side must use the same hash function for entryHash. This is the client contract.
  static computeEntryHash(entry: Omit<TapeEntryV1, 'entryHash' | 'sigCollator'>): string {
    const material = stableStringify({
      v: entry.v,
      collatorId: entry.collatorId,
      seq: entry.seq,
      prevHash: entry.prevHash,
      receivedTs: entry.receivedTs,
      order: entry.order,
    });
    return sha256Hex(material);
  }

  reset() {
    this.lastSeq = null;
    this.lastHash = null;
  }

  getState() {
    return { lastSeq: this.lastSeq, lastHash: this.lastHash };
  }

  private static computeSigMsg32(entry: TapeEntryV1): string {
    // Must match tl-collator TapeStore signing:
    // sign sha256(`${seq}|${prevHash}|${orderId}|${entryHash}`)
    return sha256Hex(`${entry.seq}|${entry.prevHash}|${entry.order.orderId}|${entry.entryHash}`);
  }

  verifyNext(
    entry: TapeEntryV1,
    opts?: { collatorId?: string; collatorPubKeyHex?: string; requireSig?: boolean }
  ): TapeVerifyResult {
    if (entry.v !== 1) return { ok: false, error: `unsupported tape version ${entry.v}` };

    if (opts?.collatorId && entry.collatorId !== opts.collatorId) {
      return { ok: false, error: `collatorId mismatch: got=${entry.collatorId} expected=${opts.collatorId}` };
    }

    // Allow duplicate replays (same or older seq) without advancing state.
    if (this.lastSeq !== null && entry.seq <= this.lastSeq) {
      // If caller wants strictness, they can check for duplicates separately.
      return { ok: true, duplicate: true };
    }

    if (this.lastSeq !== null) {
      if (entry.seq !== this.lastSeq + 1) {
        return { ok: false, error: `seq discontinuity: got=${entry.seq} expected=${this.lastSeq + 1}` };
      }
      if (entry.prevHash !== this.lastHash) {
        return { ok: false, error: `prevHash mismatch: got=${entry.prevHash} expected=${this.lastHash}` };
      }
    }

    const expected = TapeVerifier.computeEntryHash({
      v: entry.v,
      collatorId: entry.collatorId,
      seq: entry.seq,
      prevHash: entry.prevHash,
      receivedTs: entry.receivedTs,
      order: entry.order,
    });
    if (entry.entryHash !== expected) return { ok: false, error: 'entryHash mismatch' };

    const requireSig = !!opts?.requireSig;
    if (opts?.collatorPubKeyHex) {
      const msg32 = TapeVerifier.computeSigMsg32(entry);
      const ok = verifySig32(msg32, entry.sigCollator, opts.collatorPubKeyHex);
      if (!ok) return { ok: false, error: 'sigCollator verify failed' };
    } else if (requireSig) {
      return { ok: false, error: 'missing collator pubkey for sig verification' };
    }

    this.lastSeq = entry.seq;
    this.lastHash = entry.entryHash;
    return { ok: true };
  }
}
