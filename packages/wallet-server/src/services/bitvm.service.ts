import axios from 'axios';
import { fasitfyServer } from '../index';

type AnyObj = Record<string, any>;

const LOCAL_STATE = {
  watchtowerLastTick: 0,
  fraudProofsSubmittedDelta: 0,
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
