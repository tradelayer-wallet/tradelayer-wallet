import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { P2PSettingsService } from './p2p-settings.service';
import { WebRTCTransport } from 'src/p2p/webrtc/WebRTCTransport';
import type { PeerTransportStatus } from 'src/p2p/PeerTransport';
import type { OrderEnvelopeV1, TapeEntryV1 } from 'src/p2p/types';
import type { CollatorManifestFetchResult } from './collator-manifest.service';
import { CollatorManifestService } from './collator-manifest.service';
import { TapeVerifier } from 'src/p2p/tape/TapeVerifier';
import { ClearlistService } from './clearlist.service';
import { verifyManifestInfraAttestationForClearlist } from 'src/p2p/infraAttestation';

type Slot = 'primary' | 'backup';

export interface InfraApprovalStatus {
  ok: boolean;
  reason?: string;
  clearlistId?: number;
  adminAddress?: string;
  expiresAt?: number;
  issuedAt?: number;
}

export interface P2PAuditState {
  primaryUrl?: string;
  backupUrl?: string;
  warning?: string | null;
  primaryLastSeq?: number;
  backupLastSeq?: number;
  primaryManifest?: CollatorManifestFetchResult;
  backupManifest?: CollatorManifestFetchResult;
  primaryApproval?: InfraApprovalStatus;
  backupApproval?: InfraApprovalStatus;
}

const LS_LASTSEQ_BY_URL = 'tl.p2p.lastSeqByUrl';

function readLastSeqByUrl(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LS_LASTSEQ_BY_URL);
    if (!raw) return {};
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(j)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[String(k)] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function writeLastSeqByUrl(m: Record<string, number>) {
  try {
    localStorage.setItem(LS_LASTSEQ_BY_URL, JSON.stringify(m));
  } catch {}
}

@Injectable({ providedIn: 'root' })
export class P2PTransportService {
  private primary: WebRTCTransport | null = null;
  private backup: WebRTCTransport | null = null;
  private verifierByUrl = new Map<string, TapeVerifier>();
  private manifestByUrl = new Map<string, CollatorManifestFetchResult>();

  // Minimal in-memory index for local actions (e.g., building CANCEL with market hint).
  private orderMetaByOrderId = new Map<string, { market: string; visibility: any; side: 'BUY' | 'SELL' }>();

  private primaryStatusSub = new BehaviorSubject<PeerTransportStatus>({ mode: 'P2P', connected: false });
  private backupStatusSub = new BehaviorSubject<PeerTransportStatus>({ mode: 'P2P', connected: false });
  private tapeSub = new BehaviorSubject<TapeEntryV1 | null>(null);
  private auditSub = new BehaviorSubject<P2PAuditState>({ warning: null });

  primaryStatus$ = this.primaryStatusSub.asObservable();
  backupStatus$ = this.backupStatusSub.asObservable();
  tape$ = this.tapeSub.asObservable();
  audit$ = this.auditSub.asObservable();

  private heartbeatTimer: any = null;
  private lastSeqByUrl: Record<string, number> = readLastSeqByUrl();

  // LRU-ish store of primary seq->hash for divergence checks.
  private primarySeqHash = new Map<number, string>();
  private primarySeqHashMax = 5000;

  constructor(
    private settings: P2PSettingsService,
    private manifests: CollatorManifestService,
    private clearlists: ClearlistService
  ) {}

  get isConnected(): boolean {
    return !!this.primaryStatusSub.value.connected;
  }

  get primaryStatus(): PeerTransportStatus {
    return this.primaryStatusSub.value;
  }

  get backupStatus(): PeerTransportStatus {
    return this.backupStatusSub.value;
  }

  get audit(): P2PAuditState {
    return this.auditSub.value;
  }

  private setPrimaryStatus(s: PeerTransportStatus) {
    this.primaryStatusSub.next(s);
    const a = this.auditSub.value;
    this.auditSub.next({ ...a, primaryUrl: s.collatorUrl, primaryLastSeq: a.primaryLastSeq });
  }

  private setBackupStatus(s: PeerTransportStatus) {
    this.backupStatusSub.next(s);
    const a = this.auditSub.value;
    this.auditSub.next({ ...a, backupUrl: s.collatorUrl, backupLastSeq: a.backupLastSeq });
  }

  async start(): Promise<void> {
    const urls = (this.settings.collatorUrls || []).map((u) => String(u).trim()).filter(Boolean);
    if (!urls.length) throw new Error('No collator URLs configured');
    const allowIds = new Set((this.settings.allowedCollatorIds || []).map((s) => String(s).trim()).filter(Boolean));
    const requireInfra = !!this.settings.requireInfraAttestation;
    const requireVerifiedManifest = !!this.settings.requireVerifiedManifest;
    const needManifestGate = requireVerifiedManifest || allowIds.size > 0 || requireInfra;
    const requiredClearlistIdRaw = String(this.settings.requiredClearlistId || '').trim();
    const requiredClearlistId = requiredClearlistIdRaw ? Number(requiredClearlistIdRaw) : null;

    let protocolAdminAddress: string | null = null;
    if (requireInfra) {
      if (!requiredClearlistIdRaw || !Number.isInteger(requiredClearlistId) || (requiredClearlistId as any) < 0) {
        throw new Error('Infra attestation is enabled but required clearlistId is not set');
      }
      const info = await this.clearlists.getAdmin(requiredClearlistId as number);
      protocolAdminAddress = info.adminAddress ? String(info.adminAddress) : null;
      if (!protocolAdminAddress) throw new Error(`Clearlist ${requiredClearlistId} has no adminAddress`);
    }

    await this.stop();
    this.verifierByUrl.clear();
    this.manifestByUrl.clear();
    this.orderMetaByOrderId.clear();

    // Connect up to 2 collators in list order; later we pick primary by RTT if both available.
    const connected: Array<{ url: string; t: WebRTCTransport; status: PeerTransportStatus; manifest?: CollatorManifestFetchResult }> = [];
    const buffers = new Map<WebRTCTransport, TapeEntryV1[]>();
    let rolesAssigned = false;

    for (const url of urls) {
      if (connected.length >= 2) break;

      // Manifest gate becomes mandatory if any manifest-dependent checks are enabled.
      if (needManifestGate) {
        try {
          const mf = await this.manifests.fetch(url);
          if (!mf.verified) {
            this.auditSub.next({ ...this.auditSub.value, warning: `skipping collator (manifest unverified): ${url} (${mf.reason || 'unknown'})` });
            continue;
          }
          const m: any = mf.manifest;
          if (m?.protocol?.wireMsgVersion !== 1 || m?.protocol?.dataChannelLabel !== 'tl-bb') {
            this.auditSub.next({ ...this.auditSub.value, warning: `skipping collator (protocol mismatch): ${url}` });
            continue;
          }
          if (allowIds.size > 0 && !allowIds.has(String(m?.collatorId || ''))) {
            this.auditSub.next({ ...this.auditSub.value, warning: `skipping collator (not in allowlist): ${url}` });
            continue;
          }
          if (requireInfra) {
            const vr = verifyManifestInfraAttestationForClearlist(
              m,
              url,
              requiredClearlistId as number,
              protocolAdminAddress as string
            );
            if (!vr.ok) {
              this.auditSub.next({ ...this.auditSub.value, warning: `skipping collator (no valid infra attestation): ${url} (${vr.reason || 'unknown'})` });
              continue;
            }
          }
          this.manifestByUrl.set(url, mf);
        } catch (e: any) {
          this.auditSub.next({
            ...this.auditSub.value,
            warning: `skipping collator (manifest fetch failed): ${url} (${e?.message || 'unknown'})`,
          });
          continue;
        }
      }

      const fromSeq = (this.lastSeqByUrl[url] || 0) + 1;
      const t = new WebRTCTransport({ collatorUrls: [url], fromSeq });
      const buf: TapeEntryV1[] = [];
      buffers.set(t, buf);
      t.subscribeTape((e) => {
        if (!rolesAssigned) {
          buf.push(e);
          return;
        }
        const slot: Slot = this.primary === t ? 'primary' : this.backup === t ? 'backup' : 'backup';
        this.onTape(slot, url, e);
      });
      try {
        await t.start();
        const st = t.getStatus();
        let mf: CollatorManifestFetchResult | undefined;
        try {
          mf = await this.manifests.fetch(url);
        } catch {}
        if (mf) this.manifestByUrl.set(url, mf);
        connected.push({ url, t, status: st, manifest: mf });
      } catch {
        try {
          await t.stop();
        } catch {}
      }
    }

    if (!connected.length) throw new Error('No collator reachable');

    // Give each connection a chance to measure RTT (first pong).
    await new Promise((r) => setTimeout(r, 6000));
    for (const c of connected) c.status = c.t.getStatus();

    // If we have two, choose primary by lowest RTT.
    if (connected.length === 2) {
      const a = connected[0].status.rttMs ?? 999999;
      const b = connected[1].status.rttMs ?? 999999;
      if (b < a) connected.reverse();
    }

    this.primary = connected[0].t;
    this.setPrimaryStatus(this.primary.getStatus());
    if (connected[1]) {
      this.backup = connected[1].t;
      this.setBackupStatus(this.backup.getStatus());
    }

    const primaryApproval = requireInfra && connected[0].manifest?.manifest
      ? verifyManifestInfraAttestationForClearlist(
          connected[0].manifest.manifest as any,
          connected[0].url,
          requiredClearlistId as number,
          protocolAdminAddress as string
        )
      : { ok: false, reason: requireInfra ? 'missing_manifest' : 'disabled' };

    const backupApproval = requireInfra && connected[1]?.manifest?.manifest
      ? verifyManifestInfraAttestationForClearlist(
          connected[1].manifest.manifest as any,
          connected[1].url,
          requiredClearlistId as number,
          protocolAdminAddress as string
        )
      : { ok: false, reason: requireInfra ? 'missing_manifest' : 'disabled' };

    this.auditSub.next({
      warning: null,
      primaryUrl: this.primary.getStatus().collatorUrl,
      backupUrl: this.backup?.getStatus().collatorUrl,
      primaryLastSeq: this.auditSub.value.primaryLastSeq,
      backupLastSeq: this.auditSub.value.backupLastSeq,
      primaryManifest: connected[0].manifest,
      backupManifest: connected[1]?.manifest,
      primaryApproval: primaryApproval as any,
      backupApproval: backupApproval as any,
    });

    // Flush buffered tape entries now that roles are known.
    rolesAssigned = true;
    for (const c of connected) {
      const buf = buffers.get(c.t) || [];
      const slot: Slot = this.primary === c.t ? 'primary' : 'backup';
      for (const e of buf) this.onTape(slot, c.url, e);
    }

    this.startHeartbeat(urls, {
      requireVerifiedManifest,
      allowIds,
      requireInfra,
      requiredClearlistId: requiredClearlistId as number | null,
      protocolAdminAddress,
      needManifestGate,
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.primary) {
      try {
        await this.primary.stop();
      } catch {}
    }
    if (this.backup) {
      try {
        await this.backup.stop();
      } catch {}
    }
    this.primary = null;
    this.backup = null;
    this.primaryStatusSub.next({ mode: 'P2P', connected: false });
    this.backupStatusSub.next({ mode: 'P2P', connected: false });
    this.auditSub.next({ warning: null });
    this.primarySeqHash.clear();
    this.verifierByUrl.clear();
    this.manifestByUrl.clear();
    this.orderMetaByOrderId.clear();
  }

  private startHeartbeat(
    allUrls: string[],
    gate: {
      requireVerifiedManifest: boolean;
      allowIds: Set<string>;
      requireInfra: boolean;
      requiredClearlistId: number | null;
      protocolAdminAddress: string | null;
      needManifestGate: boolean;
    }
  ) {
    const deadAfterMs = 15000;
    this.heartbeatTimer = setInterval(async () => {
      try {
        const p = this.primary;
        if (!p) return;
        const ps = p.getStatus();
        this.setPrimaryStatus(ps);
        if (this.backup) this.setBackupStatus(this.backup.getStatus());

        const lastPongAt = ps.lastPongAtMs || 0;
        const dead = !ps.connected || (!!lastPongAt && Date.now() - lastPongAt > deadAfterMs);
        if (!dead) return;

        // Promote backup if possible.
        if (this.backup) {
          const oldPrimaryUrl = ps.collatorUrl;
          const newPrimary = this.backup;
          this.backup = null;
          this.primary = newPrimary;
          this.setPrimaryStatus(this.primary.getStatus());
          this.setBackupStatus({ mode: 'P2P', connected: false });
          this.auditSub.next({ ...this.auditSub.value, warning: `primary down (${oldPrimaryUrl}), failed over to backup` });
        }

        // Try to establish a new backup from remaining URLs.
        const used = new Set<string>([
          this.primaryStatusSub.value.collatorUrl || '',
          this.backupStatusSub.value.collatorUrl || '',
        ].filter(Boolean));

        for (const url of allUrls) {
          if (used.has(url)) continue;
          try {
            if (gate.needManifestGate) {
              const mf = await this.manifests.fetch(url);
              if (!mf.verified) continue;
              const m: any = mf.manifest;
              if (m?.protocol?.wireMsgVersion !== 1 || m?.protocol?.dataChannelLabel !== 'tl-bb') continue;
              if (gate.allowIds.size > 0 && !gate.allowIds.has(String(m?.collatorId || ''))) continue;
              if (gate.requireInfra) {
                if (!Number.isInteger(gate.requiredClearlistId as number) || !gate.protocolAdminAddress) continue;
                const vr = verifyManifestInfraAttestationForClearlist(
                  m,
                  url,
                  gate.requiredClearlistId as number,
                  gate.protocolAdminAddress
                );
                if (!vr.ok) continue;
              }
              this.manifestByUrl.set(url, mf);
            }
            const fromSeq = (this.lastSeqByUrl[url] || 0) + 1;
            const t = new WebRTCTransport({ collatorUrls: [url], fromSeq });
            t.subscribeTape((e) => this.onTape('backup', url, e));
            await t.start();
            this.backup = t;
            this.setBackupStatus(t.getStatus());
            this.auditSub.next({ ...this.auditSub.value, warning: this.auditSub.value.warning || null });
            break;
          } catch {
            // try next
          }
        }
      } catch {
        // swallow heartbeat loop errors
      }
    }, 2000);
  }

  private noteSeqHash(seq: number, entryHash: string) {
    this.primarySeqHash.set(seq, entryHash);
    if (this.primarySeqHash.size > this.primarySeqHashMax) {
      const oldest = this.primarySeqHash.keys().next().value;
      if (typeof oldest === 'number') this.primarySeqHash.delete(oldest);
    }
  }

  private onTape(slot: Slot, url: string, e: TapeEntryV1) {
    // Verify tape entry integrity before consuming or advancing local catch-up state.
    let v = this.verifierByUrl.get(url);
    if (!v) {
      v = new TapeVerifier();
      this.verifierByUrl.set(url, v);
    }

    const mf = this.manifestByUrl.get(url);
    const m: any = mf?.manifest;
    const requireSig = !!this.settings.requireVerifiedManifest;
    const vr = v.verifyNext(e, {
      collatorId: typeof m?.collatorId === 'string' ? m.collatorId : undefined,
      collatorPubKeyHex: typeof m?.collatorPubKey === 'string' ? m.collatorPubKey : undefined,
      requireSig,
    });
    if (!vr.ok) {
      const prefix = slot === 'primary' ? 'primary' : 'backup';
      this.auditSub.next({ ...this.auditSub.value, warning: `${prefix} tape reject (${url}): ${vr.error || 'invalid entry'}` });
      return;
    }

    // Update a minimal local index from NEW entries (helps local UX like cancel hints).
    try {
      if (e?.order?.kind === 'NEW' && typeof e?.order?.orderId === 'string') {
        const b: any = e.order.body;
        this.orderMetaByOrderId.set(e.order.orderId, {
          market: String(b?.market || ''),
          visibility: b?.visibility ?? { kind: 'PUBLIC' },
          side: (b?.side === 'SELL' ? 'SELL' : 'BUY') as any,
        });
      }
    } catch {}

    // Persist last seq by URL for catch-up (only after verification).
    if (typeof e.seq === 'number') {
      this.lastSeqByUrl[url] = Math.max(this.lastSeqByUrl[url] || 0, e.seq);
      writeLastSeqByUrl(this.lastSeqByUrl);
    }

    const a = this.auditSub.value;
    if (slot === 'primary') {
      this.auditSub.next({ ...a, primaryLastSeq: e.seq });
      const prev = this.primarySeqHash.get(e.seq);
      if (prev && prev === e.entryHash) {
        return; // duplicate replay
      }
      if (prev && prev !== e.entryHash) {
        this.auditSub.next({ ...this.auditSub.value, warning: `primary tape divergence at seq=${e.seq}` });
      }
      this.noteSeqHash(e.seq, e.entryHash);
      this.tapeSub.next(e);
      return;
    }

    // backup audit-only
    this.auditSub.next({ ...a, backupLastSeq: e.seq });

    const primaryHash = this.primarySeqHash.get(e.seq);
    if (primaryHash && primaryHash !== e.entryHash) {
      this.auditSub.next({
        ...this.auditSub.value,
        warning: `tape divergence at seq=${e.seq}: primaryHash != backupHash`,
      });
    } else if ((a.primaryLastSeq || 0) + 25 < e.seq) {
      this.auditSub.next({
        ...this.auditSub.value,
        warning: `primary lagging backup by >25 seq (p=${a.primaryLastSeq} b=${e.seq})`,
      });
    }
  }

  async submit(order: OrderEnvelopeV1): Promise<void> {
    if (!this.primary) throw new Error('P2P transport not started');
    await this.primary.submit(order);
    this.setPrimaryStatus(this.primary.getStatus());
  }

  // Best-effort helper for building client-side cancels/replaces.
  getOrderMeta(orderId: string): { market: string; visibility: any; side: 'BUY' | 'SELL' } | null {
    return this.orderMetaByOrderId.get(orderId) || null;
  }
}
