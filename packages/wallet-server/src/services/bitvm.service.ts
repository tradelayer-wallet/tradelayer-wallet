import axios from 'axios';
import { fasitfyServer } from '../index';

type AnyObj = Record<string, any>;
type WatchtowerQuery = { propertyId?: number; dlcRef?: string };

const LOCAL_STATE = {
  watchtowerLastTick: 0,
  fraudProofsSubmittedDelta: 0,
};

type WatchtowerActionType =
  | 'ALERT_EXPIRING_CHALLENGES'
  | 'ALERT_ESCROW_PRESSURE'
  | 'ALERT_SWEEP_PRESSURE'
  | 'ALERT_COMMIT_SCHEME_MISMATCH'
  | 'AUTO_EMIT_FRAUD_PROOF';

interface WatchtowerAction {
  type: WatchtowerActionType;
  severity: 'info' | 'warn' | 'critical';
  message: string;
  autoApplied: boolean;
}

interface WatchtowerState {
  running: boolean;
  intervalMs: number;
  autoFraudProof: boolean;
  lastRunAt: number;
  lastError: string;
  actions: WatchtowerAction[];
  query: WatchtowerQuery;
}

const WATCHTOWER: WatchtowerState & { timer: ReturnType<typeof setInterval> | null } = {
  running: false,
  intervalMs: Number(process.env.BITVM_WATCHTOWER_INTERVAL_MS || 15000),
  autoFraudProof: process.env.BITVM_WATCHTOWER_AUTO_FRAUD_PROOF === '1',
  lastRunAt: 0,
  lastError: '',
  actions: [],
  query: {},
  timer: null,
};

function trimSlash(url: string): string {
  return String(url || '').replace(/\/+$/, '');
}

function requireApiUrl(): string {
  const base = String(fasitfyServer.relayerApiUrl || '').trim();
  if (!base) {
    throw new Error('BitVM status source is not configured. Set API URL in wallet first.');
  }
  return trimSlash(base);
}

function normalizeStatus(raw: AnyObj): AnyObj {
  const status = raw || {};
  const challenge = status.challenge || {};
  const cache = status.cache || {};
  const sweep = status.sweep || {};
  const hooks = status.hooks || {};
  return {
    source: status.source || 'walletListener',
    atBlock: Number(status.atBlock || 0),
    featureEnabled: !!status.featureEnabled,
    commitScheme: status.commitScheme || 'legacy-merkle',
    updatedAt: Number(status.updatedAt || Date.now()),
    cache: {
      openCaches: Number(cache.openCaches || 0),
      pendingEscrow: Number(cache.pendingEscrow || 0),
      pendingEscrowCap: Number(cache.pendingEscrowCap || 0),
      pendingEscrowPerDlc: Number(cache.pendingEscrowPerDlc || 0),
      pendingEscrowPerDlcCap: Number(cache.pendingEscrowPerDlcCap || 0),
    },
    challenge: {
      active: Number(challenge.active || 0),
      expiringSoon: Number(challenge.expiringSoon || 0),
      fraudProofsSubmitted: Number(challenge.fraudProofsSubmitted || 0) + LOCAL_STATE.fraudProofsSubmittedDelta,
      watchtowerLastTick: LOCAL_STATE.watchtowerLastTick || Number(challenge.watchtowerLastTick || 0),
    },
    sweep: {
      windowBlocks: Number(sweep.windowBlocks || 0),
      depositsThisWindow: Number(sweep.depositsThisWindow || 0),
      withdrawalsThisWindow: Number(sweep.withdrawalsThisWindow || 0),
      sweepsThisWindow: Number(sweep.sweepsThisWindow || 0),
      maxDepositPerWindow: Number(sweep.maxDepositPerWindow || 0),
      maxWithdrawPerWindow: Number(sweep.maxWithdrawPerWindow || 0),
      maxSweepPerWindow: Number(sweep.maxSweepPerWindow || 0),
    },
    hooks: {
      challengeObservedReady: hooks.challengeObservedReady !== false,
      fraudProofEmitReady: hooks.fraudProofEmitReady !== false,
      payoutFinalizedReady: hooks.payoutFinalizedReady !== false,
    }
  };
}

export async function fetchBitvmStatus(query?: { propertyId?: number; dlcRef?: string }) {
  const base = requireApiUrl();
  const body: AnyObj = {};
  if (query && Number.isFinite(query.propertyId) && Number(query.propertyId) > 0) {
    body.propertyId = Number(query.propertyId);
  }
  if (query?.dlcRef) {
    body.dlcRef = String(query.dlcRef).trim();
  }
  const { data } = await axios.post(`${base}/tl_bitvmStatus`, body, { timeout: 7000 });
  return normalizeStatus(data || {});
}

function ratio(num: number, den: number): number {
  if (!den || den <= 0) return 0;
  return num / den;
}

function evaluateWatchtowerActions(status: AnyObj, autoFraudProof: boolean): WatchtowerAction[] {
  const actions: WatchtowerAction[] = [];
  const expiring = Number(status?.challenge?.expiringSoon || 0);
  const pendingEscrow = Number(status?.cache?.pendingEscrow || 0);
  const escrowCap = Number(status?.cache?.pendingEscrowCap || 0);
  const sweeps = Number(status?.sweep?.sweepsThisWindow || 0);
  const sweepCap = Number(status?.sweep?.maxSweepPerWindow || 0);
  const featureEnabled = !!status?.featureEnabled;
  const scheme = String(status?.commitScheme || '');

  if (expiring > 0) {
    actions.push({
      type: 'ALERT_EXPIRING_CHALLENGES',
      severity: 'critical',
      message: `${expiring} challenge(s) nearing deadline`,
      autoApplied: false,
    });
  }
  if (ratio(pendingEscrow, escrowCap) >= 0.9 && escrowCap > 0) {
    actions.push({
      type: 'ALERT_ESCROW_PRESSURE',
      severity: 'warn',
      message: `Escrow pressure high (${pendingEscrow}/${escrowCap})`,
      autoApplied: false,
    });
  }
  if (ratio(sweeps, sweepCap) >= 0.9 && sweepCap > 0) {
    actions.push({
      type: 'ALERT_SWEEP_PRESSURE',
      severity: 'warn',
      message: `Sweep window near cap (${sweeps}/${sweepCap})`,
      autoApplied: false,
    });
  }
  if (featureEnabled && scheme !== 'experimental-binohash') {
    actions.push({
      type: 'ALERT_COMMIT_SCHEME_MISMATCH',
      severity: 'warn',
      message: 'State-root gate enabled while commit scheme is not binohash',
      autoApplied: false,
    });
  }
  if (autoFraudProof && expiring > 0) {
    actions.push({
      type: 'AUTO_EMIT_FRAUD_PROOF',
      severity: 'info',
      message: 'Auto fraud-proof emission policy triggered',
      autoApplied: true,
    });
  }
  return actions;
}

export function getBitvmWatchtowerStatus() {
  return {
    running: WATCHTOWER.running,
    intervalMs: WATCHTOWER.intervalMs,
    autoFraudProof: WATCHTOWER.autoFraudProof,
    lastRunAt: WATCHTOWER.lastRunAt,
    lastError: WATCHTOWER.lastError,
    actions: WATCHTOWER.actions,
    query: WATCHTOWER.query,
  };
}

async function runWatchtowerScanOnce() {
  const status = await bitvmWatchtowerTick(WATCHTOWER.query);
  const actions = evaluateWatchtowerActions(status, WATCHTOWER.autoFraudProof);
  WATCHTOWER.lastRunAt = Date.now();
  WATCHTOWER.actions = actions;
  WATCHTOWER.lastError = '';
  if (WATCHTOWER.autoFraudProof && actions.some((a) => a.type === 'AUTO_EMIT_FRAUD_PROOF')) {
    await bitvmEmitFraudProof(WATCHTOWER.query);
  }
  return { status, watchtower: getBitvmWatchtowerStatus() };
}

export async function bitvmWatchtowerScan(query?: WatchtowerQuery) {
  if (query) WATCHTOWER.query = { ...WATCHTOWER.query, ...query };
  return runWatchtowerScanOnce();
}

export function bitvmWatchtowerStart(opts?: {
  intervalMs?: number;
  autoFraudProof?: boolean;
  propertyId?: number;
  dlcRef?: string;
}) {
  if (opts?.intervalMs && Number.isFinite(opts.intervalMs) && opts.intervalMs >= 1000) {
    WATCHTOWER.intervalMs = Math.floor(opts.intervalMs);
  }
  if (typeof opts?.autoFraudProof === 'boolean') {
    WATCHTOWER.autoFraudProof = opts.autoFraudProof;
  }
  if (opts && (opts.propertyId || opts.dlcRef)) {
    WATCHTOWER.query = {
      propertyId: Number.isFinite(opts.propertyId) && Number(opts.propertyId) > 0 ? Number(opts.propertyId) : undefined,
      dlcRef: opts.dlcRef ? String(opts.dlcRef).trim() : undefined,
    };
  }
  if (WATCHTOWER.timer) clearInterval(WATCHTOWER.timer);
  WATCHTOWER.running = true;
  WATCHTOWER.timer = setInterval(() => {
    runWatchtowerScanOnce().catch((err: any) => {
      WATCHTOWER.lastError = err?.message || String(err || 'watchtower scan failed');
    });
  }, WATCHTOWER.intervalMs);
  return getBitvmWatchtowerStatus();
}

export function bitvmWatchtowerStop() {
  if (WATCHTOWER.timer) clearInterval(WATCHTOWER.timer);
  WATCHTOWER.timer = null;
  WATCHTOWER.running = false;
  return getBitvmWatchtowerStatus();
}

export async function bitvmWatchtowerTick(query?: { propertyId?: number; dlcRef?: string }) {
  LOCAL_STATE.watchtowerLastTick = Date.now();
  const status = await fetchBitvmStatus(query);
  return { ...status, updatedAt: Date.now() };
}

export async function bitvmEmitFraudProof(query?: { propertyId?: number; dlcRef?: string }) {
  LOCAL_STATE.fraudProofsSubmittedDelta += 1;
  const status = await fetchBitvmStatus(query);
  return { ...status, updatedAt: Date.now() };
}
