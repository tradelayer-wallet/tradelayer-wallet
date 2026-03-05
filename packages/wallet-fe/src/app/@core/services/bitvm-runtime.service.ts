import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { MainApiService } from '../apis/main-api.service';

const LS_BITVM_FEATURE_FLAG = 'tl.experimental_binohash_bitvm';
const LS_BITVM_STATUS = 'tl.bitvm.status';

type VoidHook = () => void;

export interface BitvmStatus {
  featureEnabled: boolean;
  commitScheme: 'legacy-merkle' | 'experimental-binohash';
  updatedAt: number;
  cache: {
    openCaches: number;
    pendingEscrow: number;
    pendingEscrowPerDlc?: number;
    pendingEscrowCap: number;
    pendingEscrowPerDlcCap: number;
  };
  challenge: {
    active: number;
    expiringSoon: number;
    fraudProofsSubmitted: number;
    watchtowerLastTick: number;
  };
  sweep: {
    windowBlocks: number;
    depositsThisWindow: number;
    withdrawalsThisWindow: number;
    sweepsThisWindow: number;
    maxDepositPerWindow: number;
    maxWithdrawPerWindow: number;
    maxSweepPerWindow: number;
  };
  hooks: {
    challengeObservedReady: boolean;
    fraudProofEmitReady: boolean;
    payoutFinalizedReady: boolean;
  };
  watchtower?: {
    running: boolean;
    intervalMs: number;
    autoFraudProof: boolean;
    lastRunAt: number;
    lastError: string;
    actions: Array<{ type: string; severity: string; message: string; autoApplied: boolean }>;
  };
}

@Injectable({ providedIn: 'root' })
export class BitvmRuntimeService {
  private challengeObservedHooks: VoidHook[] = [];
  private fraudProofEmitHooks: VoidHook[] = [];
  private payoutFinalizedHooks: VoidHook[] = [];
  private watchtowerTimer: ReturnType<typeof setInterval> | null = null;

  private readonly statusSub = new BehaviorSubject<BitvmStatus>(this.defaultStatus());
  readonly status$ = this.statusSub.asObservable();

  constructor(private mainApi: MainApiService) {}

  get status(): BitvmStatus {
    return this.statusSub.value;
  }

  get featureEnabled(): boolean {
    return localStorage.getItem(LS_BITVM_FEATURE_FLAG) === '1';
  }

  setFeatureEnabled(enabled: boolean): void {
    localStorage.setItem(LS_BITVM_FEATURE_FLAG, enabled ? '1' : '0');
    const next: BitvmStatus = {
      ...this.status,
      featureEnabled: enabled,
      commitScheme: enabled ? 'experimental-binohash' : 'legacy-merkle',
      updatedAt: Date.now(),
    };
    this.persistAndPublish(next);
  }

  registerChallengeObservedHook(hook: VoidHook): void {
    this.challengeObservedHooks.push(hook);
    this.publishHookReadiness();
  }

  registerFraudProofEmitHook(hook: VoidHook): void {
    this.fraudProofEmitHooks.push(hook);
    this.publishHookReadiness();
  }

  registerPayoutFinalizedHook(hook: VoidHook): void {
    this.payoutFinalizedHooks.push(hook);
    this.publishHookReadiness();
  }

  startWatchtowerLoop(): void {
    if (this.watchtowerTimer !== null) return;
    this.watchtowerTimer = setInterval(() => {
      this.runWatchtowerTick().catch(() => undefined);
    }, 15000);
  }

  stopWatchtowerLoop(): void {
    if (this.watchtowerTimer === null) return;
    clearInterval(this.watchtowerTimer);
    this.watchtowerTimer = null;
  }

  async refresh(): Promise<void> {
    const saved = this.readSavedStatus();
    const fallbackMerged: BitvmStatus = {
      ...this.defaultStatus(),
      ...saved,
      featureEnabled: this.featureEnabled,
      commitScheme: this.featureEnabled ? 'experimental-binohash' : 'legacy-merkle',
      updatedAt: Date.now(),
    };
    try {
      const res = await this.mainApi.getBitvmStatus().toPromise();
      const wtRes = await this.mainApi.getBitvmWatchtowerStatus().toPromise().catch(() => null);
      if (res?.data) {
        const remote = res.data as Partial<BitvmStatus>;
        const mergedRemote: BitvmStatus = {
          ...fallbackMerged,
          ...remote,
          cache: {
            ...fallbackMerged.cache,
            ...(remote.cache || {}),
          },
          challenge: {
            ...fallbackMerged.challenge,
            ...(remote.challenge || {}),
          },
          sweep: {
            ...fallbackMerged.sweep,
            ...(remote.sweep || {}),
          },
          hooks: {
            ...fallbackMerged.hooks,
            ...(remote.hooks || {}),
          },
          watchtower: wtRes?.data ? wtRes.data : this.status.watchtower,
          featureEnabled: this.featureEnabled,
          commitScheme: this.featureEnabled ? 'experimental-binohash' : 'legacy-merkle',
          updatedAt: Date.now(),
        };
        this.persistAndPublish(mergedRemote);
        this.publishHookReadiness();
        return;
      }
    } catch {}
    this.persistAndPublish(fallbackMerged);
    this.publishHookReadiness();
  }

  async runWatchtowerTick(): Promise<void> {
    try {
      const res = await this.mainApi.bitvmWatchtowerScan().toPromise();
      if (res?.data?.status) {
        const remote = res.data.status as Partial<BitvmStatus>;
        const next: BitvmStatus = {
          ...this.status,
          ...remote,
          cache: {
            ...this.status.cache,
            ...(remote.cache || {}),
          },
          challenge: {
            ...this.status.challenge,
            ...(remote.challenge || {}),
          },
          sweep: {
            ...this.status.sweep,
            ...(remote.sweep || {}),
          },
          hooks: {
            ...this.status.hooks,
            ...(remote.hooks || {}),
          },
          watchtower: res.data.watchtower || this.status.watchtower,
          updatedAt: Date.now(),
        };
        this.challengeObservedHooks.forEach((hook) => hook());
        this.persistAndPublish(next);
        return;
      }
    } catch {}
    const next: BitvmStatus = {
      ...this.status,
      challenge: {
        ...this.status.challenge,
        watchtowerLastTick: Date.now(),
      },
      updatedAt: Date.now(),
    };
    this.challengeObservedHooks.forEach((hook) => hook());
    this.persistAndPublish(next);
  }

  async emitFraudProof(): Promise<void> {
    try {
      const res = await this.mainApi.bitvmEmitFraudProof().toPromise();
      if (res?.data) {
        const remote = res.data as Partial<BitvmStatus>;
        const next: BitvmStatus = {
          ...this.status,
          ...remote,
          cache: {
            ...this.status.cache,
            ...(remote.cache || {}),
          },
          challenge: {
            ...this.status.challenge,
            ...(remote.challenge || {}),
          },
          sweep: {
            ...this.status.sweep,
            ...(remote.sweep || {}),
          },
          hooks: {
            ...this.status.hooks,
            ...(remote.hooks || {}),
          },
          watchtower: this.status.watchtower,
          updatedAt: Date.now(),
        };
        this.fraudProofEmitHooks.forEach((hook) => hook());
        this.persistAndPublish(next);
        return;
      }
    } catch {}
    const next: BitvmStatus = {
      ...this.status,
      challenge: {
        ...this.status.challenge,
        fraudProofsSubmitted: this.status.challenge.fraudProofsSubmitted + 1,
      },
      updatedAt: Date.now(),
    };
    this.fraudProofEmitHooks.forEach((hook) => hook());
    this.persistAndPublish(next);
  }

  private publishHookReadiness(): void {
    const next: BitvmStatus = {
      ...this.status,
      hooks: {
        challengeObservedReady: this.challengeObservedHooks.length > 0,
        fraudProofEmitReady: this.fraudProofEmitHooks.length > 0,
        payoutFinalizedReady: this.payoutFinalizedHooks.length > 0,
      },
      updatedAt: Date.now(),
    };
    this.persistAndPublish(next);
  }

  private readSavedStatus(): Partial<BitvmStatus> {
    try {
      const raw = localStorage.getItem(LS_BITVM_STATUS);
      if (!raw) return {};
      return JSON.parse(raw) as Partial<BitvmStatus>;
    } catch {
      return {};
    }
  }

  private persistAndPublish(next: BitvmStatus): void {
    localStorage.setItem(LS_BITVM_STATUS, JSON.stringify(next));
    this.statusSub.next(next);
  }

  private defaultStatus(): BitvmStatus {
    const enabled = this.featureEnabled;
    return {
      featureEnabled: enabled,
      commitScheme: enabled ? 'experimental-binohash' : 'legacy-merkle',
      updatedAt: Date.now(),
      cache: {
        openCaches: 0,
        pendingEscrow: 0,
        pendingEscrowPerDlc: 0,
        pendingEscrowCap: 1000,
        pendingEscrowPerDlcCap: 250,
      },
      challenge: {
        active: 0,
        expiringSoon: 0,
        fraudProofsSubmitted: 0,
        watchtowerLastTick: 0,
      },
      sweep: {
        windowBlocks: 6,
        depositsThisWindow: 0,
        withdrawalsThisWindow: 0,
        sweepsThisWindow: 0,
        maxDepositPerWindow: 50,
        maxWithdrawPerWindow: 50,
        maxSweepPerWindow: 100,
      },
      hooks: {
        challengeObservedReady: false,
        fraudProofEmitReady: false,
        payoutFinalizedReady: false,
      },
      watchtower: {
        running: false,
        intervalMs: 15000,
        autoFraudProof: false,
        lastRunAt: 0,
        lastError: '',
        actions: [],
      },
    };
  }

  async startWatchtower(opts?: { intervalMs?: number; autoFraudProof?: boolean }): Promise<void> {
    const res = await this.mainApi.bitvmWatchtowerStart(opts || {}).toPromise();
    if (res?.data) {
      this.persistAndPublish({
        ...this.status,
        watchtower: res.data,
        updatedAt: Date.now(),
      });
    }
  }

  async stopWatchtower(): Promise<void> {
    const res = await this.mainApi.bitvmWatchtowerStop().toPromise();
    if (res?.data) {
      this.persistAndPublish({
        ...this.status,
        watchtower: res.data,
        updatedAt: Date.now(),
      });
    }
  }
}
