import axios from 'axios';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as secp from 'tiny-secp256k1';
import { RpcClient } from 'tl-rpc';
import { fasitfyServer } from '../index';

type AnyObj = Record<string, any>;
type WatchtowerQuery = {
  propertyId?: number;
  dlcRef?: string;
  cacheId?: string;
  oracleId?: number;
  senderAddress?: string;
  challengerAddress?: string;
  challengeBondAmount?: number;
  challengeBondPropertyId?: number;
};
type ExpiringTarget = {
  cacheId: string;
  dlcRef: string;
  propertyId: number;
  amount: number;
  fromAddress: string;
  toAddress: string;
  challengeDeadlineBlock: number;
  resolverAddress: string;
};

type ProceduralExecutionRequest = {
  recipientAddress: string;
  amount: number | string;
  depositTxid?: string | null;
  redeemTxid?: string | null;
  expectedExecutionContextId?: string | null;
  expectedExecutionContextHash?: string | null;
  expectedFundingTxid?: string | null;
  expectedSelectedPathId?: string | null;
  expectedTemplateId?: string | null;
  expectedContractId?: string | null;
};

type BitvmArtifactGenerationRequest = {
  mode?: string | null;
  pathName?: string | null;
  broadcastFunding?: boolean | string | number | null;
  includeSettlementValidation?: boolean | string | number | null;
  forceSettlementValidation?: boolean | string | number | null;
  provisionIfMissing?: boolean | string | number | null;
  rpcUrl?: string | null;
  rpcUser?: string | null;
  rpcPass?: string | null;
  sourceWallet?: string | null;
  destinationWallet?: string | null;
  minConfirmations?: number | string | null;
};

type BitvmRpcConfig = {
  url: string;
  username: string;
  password: string;
  host: string;
  port: number;
  sourceWallet: string;
  destinationWallet: string;
  minConfirmations: number;
};

type CommandRunResult = {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

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

const DEFAULT_REFEREE_ARTIFACTS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'UTXORef',
  'UTXO-Ref',
  'bitvm3',
  'utxo_referee',
  'artifacts'
);
const DEFAULT_REFEREE_ROOT_DIR = path.resolve(DEFAULT_REFEREE_ARTIFACTS_DIR, '..');
const DEFAULT_PROVISION_SCRIPT_PATH = path.join(DEFAULT_REFEREE_ROOT_DIR, 'm1_ltc_wallet_provision.ps1');
const DEFAULT_PIPELINE_SCRIPT_PATH = path.join(DEFAULT_REFEREE_ROOT_DIR, 'm1_pipeline.js');

const PROCEDURAL_SYNC_FILE = 'bitvm_procedural_sync_latest.json';
const PIPELINE_FILE = 'm1_pipeline_latest.json';
const PARALLEL_UTXO_FILE = 'm1_parallel_utxo_index_latest.json';
const CHALLENGE_BUNDLE_FILE = 'm1_challenge_bundle_latest.json';
const FAST_ROLL_FILE = 'm1_fast_roll_latest.json';
const LIVE_AUDITED_VAULT_FILE = 'bitvm_live_audited_vault_latest.json';

type BitvmExecutionContext = {
  ready: boolean;
  validationReady: boolean;
  contextId: string | null;
  contextHash: string | null;
  artifactDir: string;
  chainId: string | null;
  chainTicker: string | null;
  state: string | null;
  receiptPropertyId?: number;
  receiptTicker: string | null;
  templateId: string | null;
  templateHash: string | null;
  contractId: string | null;
  fundingTxid: string | null;
  fundingVout: number | null;
  fundingValueLtc: number | null;
  fundingValueSats: string | null;
  fundingAddress: string | null;
  vaultAddress: string | null;
  releaseSpendAddress: string | null;
  adminAddress: string | null;
  holderAddress: string | null;
  operatorAddress: string | null;
  oracleAddress: string | null;
  residualAddress: string | null;
  settlementRoute: string | null;
  settlementKind: string | null;
  selectedPathId: string | null;
  selectedPathTxid: string | null;
  nextContractId: string | null;
  pipelineMode: string | null;
  pipelineSelectedPath: string | null;
  settlementValidation: string | null;
  witnessScriptHex: string | null;
  fundingScriptPubKeyHex: string | null;
  fundedAmountLtc: number | null;
  replayOnly: boolean;
  releaseReady: boolean;
  sourceArtifacts: Record<string, AnyObj | null>;
  warnings: string[];
  errors: string[];
};

type RefereeArtifacts = {
  proceduralSync: AnyObj | null;
  pipeline: AnyObj | null;
  parallelUtxoIndex: AnyObj | null;
  challengeBundle: AnyObj | null;
  fastRoll: AnyObj | null;
  liveAuditedVault: AnyObj | null;
  executionContext: BitvmExecutionContext | null;
  proceduralConfig: AnyObj | null;
};

function getRefereeArtifactsDir(): string {
  const configured = String(process.env.BITVM_REFEREE_ARTIFACTS_DIR || '').trim();
  return configured || DEFAULT_REFEREE_ARTIFACTS_DIR;
}

function getRefereeRootDir(): string {
  const configured = String(process.env.BITVM_REFEREE_ROOT_DIR || '').trim();
  return configured || DEFAULT_REFEREE_ROOT_DIR;
}

function loadArtifactJson(fileName: string): AnyObj | null {
  const filePath = path.join(getRefereeArtifactsDir(), fileName);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function compactOutput(output: string, maxLines = 20, maxChars = 8000): string[] {
  const trimmed = String(output || '').trim();
  if (!trimmed) {
    return [];
  }

  let body = trimmed;
  if (body.length > maxChars) {
    body = body.slice(body.length - maxChars);
  }

  const lines = body.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines));
}

function normalizeOptionalString(value: any): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeOptionalLower(value: any): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeOptionalTxid(value: any): string | null {
  const normalized = normalizeOptionalLower(value);
  if (!normalized) {
    return null;
  }
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : normalized;
}

function normalizeOptionalPathId(value: any): string | null {
  return normalizeOptionalLower(value);
}

function uniqueDefinedStrings(values: any[], normalizer: (value: any) => string | null): string[] {
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizer(value);
    if (!normalized || out.indexOf(normalized) >= 0) {
      continue;
    }
    out.push(normalized);
  }
  return out;
}

function pickSingleNormalizedValue(
  values: any[],
  normalizer: (value: any) => string | null,
  fieldName: string,
  errors: string[],
): string | null {
  const unique = uniqueDefinedStrings(values, normalizer);
  if (unique.length > 1) {
    errors.push(`${fieldName} mismatch across referee artifacts: ${unique.join(', ')}`);
    return unique[0];
  }
  return unique[0] || null;
}

function normalizeArtifactStepStatus(pipeline: AnyObj | null, stepId: string): string | null {
  const summaryStatus = normalizeOptionalLower(pipeline?.summary?.[stepId]?.status);
  if (summaryStatus) {
    return summaryStatus;
  }
  const steps = Array.isArray(pipeline?.steps) ? pipeline.steps : [];
  const step = steps.find((entry: AnyObj) => String(entry?.id || '').trim() === stepId);
  return normalizeOptionalLower(step?.status);
}

function findParallelTransaction(parallelUtxoIndex: AnyObj | null, txRole: string): AnyObj | null {
  const txs = Array.isArray(parallelUtxoIndex?.transactions) ? parallelUtxoIndex.transactions : [];
  return txs.find((tx: AnyObj) => normalizeOptionalPathId(tx?.txRole) === normalizeOptionalPathId(txRole)) || null;
}

function findFundingOutputAddress(parallelUtxoIndex: AnyObj | null): string | null {
  const fundingTx = findParallelTransaction(parallelUtxoIndex, 'funding');
  const outputs = Array.isArray(fundingTx?.outputs) ? fundingTx.outputs : [];
  const fundingOutput = outputs.find((output: AnyObj) => String(output?.role || '').trim() === 'funding-output');
  return normalizeOptionalString(fundingOutput?.address);
}

function toRoundedLtcFromSats(valueSats: any): number | null {
  if (valueSats === null || valueSats === undefined || valueSats === '') {
    return null;
  }
  const sats = Number(valueSats);
  if (!Number.isFinite(sats)) {
    return null;
  }
  return Number((sats / 1e8).toFixed(8));
}

function normalizeLtcAmount(value: any): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Number(parsed.toFixed(8));
}

function sameLtcAmount(a: any, b: any): boolean {
  const normalizedA = normalizeLtcAmount(a);
  const normalizedB = normalizeLtcAmount(b);
  if (normalizedA === null || normalizedB === null) {
    return false;
  }
  return Math.round(normalizedA * 1e8) === Math.round(normalizedB * 1e8);
}

function executionContextHashPayload(context: {
  chainId: string | null;
  templateId: string | null;
  contractId: string | null;
  fundingTxid: string | null;
  fundingVout: number | null;
  selectedPathId: string | null;
  selectedPathTxid: string | null;
  receiptPropertyId?: number;
  settlementRoute: string | null;
}) {
  return JSON.stringify({
    chainId: context.chainId || '',
    templateId: context.templateId || '',
    contractId: context.contractId || '',
    fundingTxid: context.fundingTxid || '',
    fundingVout: context.fundingVout ?? '',
    selectedPathId: context.selectedPathId || '',
    selectedPathTxid: context.selectedPathTxid || '',
    receiptPropertyId: context.receiptPropertyId || '',
    settlementRoute: context.settlementRoute || '',
  });
}

function compactArtifactSummary(artifact: AnyObj | null) {
  if (!artifact || typeof artifact !== 'object') {
    return null;
  }
  return {
    kind: normalizeOptionalString(artifact.kind),
    createdAt: normalizeOptionalString(artifact.createdAt),
  };
}

function inferProceduralChainId(sync: AnyObj | null): string | null {
  const direct = String(sync?.parallelUtxoIndex?.chainId || '').trim();
  if (direct) {
    return direct;
  }

  const network = String(sync?.chain?.network || '').trim().toLowerCase();
  if (network === 'test') {
    return 'litecoin-testnet';
  }
  if (network === 'main') {
    return 'litecoin-mainnet';
  }
  return null;
}

function inferChainTicker(chainId: string | null): string | null {
  if (!chainId) {
    return null;
  }
  if (chainId.startsWith('bitcoin')) {
    return 'BTC';
  }
  if (chainId.startsWith('litecoin')) {
    return 'LTC';
  }
  return null;
}

function buildExecutionContext(artifacts: {
  proceduralSync: AnyObj | null;
  pipeline: AnyObj | null;
  parallelUtxoIndex: AnyObj | null;
  challengeBundle: AnyObj | null;
  fastRoll: AnyObj | null;
  liveAuditedVault: AnyObj | null;
}): BitvmExecutionContext | null {
  const sync = artifacts.proceduralSync;
  const pipeline = artifacts.pipeline;
  const parallelUtxoIndex = artifacts.parallelUtxoIndex;
  const challengeBundle = artifacts.challengeBundle;
  const fastRoll = artifacts.fastRoll;
  const liveAuditedVault = artifacts.liveAuditedVault;
  if (!sync && !parallelUtxoIndex && !challengeBundle && !fastRoll) {
    return null;
  }

  const warnings: string[] = [];
  const errors: string[] = [];
  const chainId = pickSingleNormalizedValue(
    [
      sync?.parallelUtxoIndex?.chainId,
      parallelUtxoIndex?.chain?.chainId,
      inferProceduralChainId(sync),
    ],
    normalizeOptionalLower,
    'chainId',
    errors,
  );
  const chainTicker = inferChainTicker(chainId);
  const receiptPropertyIdNum = Number(sync?.propertyId || 0);
  const receiptPropertyId = Number.isFinite(receiptPropertyIdNum) && receiptPropertyIdNum > 0
    ? receiptPropertyIdNum
    : undefined;
  const templateId = normalizeOptionalString(sync?.templateId);
  const templateHash = normalizeOptionalLower(sync?.templateHash);
  const contractId = normalizeOptionalString(sync?.contractId);
  const selectedPathId = pickSingleNormalizedValue(
    [
      challengeBundle?.selectedPathId,
      challengeBundle?.selectedPath?.pathId,
      pipeline?.options?.selectedPath,
      sync?.settlement?.route,
    ],
    normalizeOptionalPathId,
    'selectedPathId',
    errors,
  );
  const fundingTxid = pickSingleNormalizedValue(
    [
      sync?.fundingTxid,
      sync?.parallelUtxoIndex?.fundingTxid,
      parallelUtxoIndex?.anchors?.fundingTxid,
      challengeBundle?.binding?.fundingTxidFinalized,
      challengeBundle?.binding?.fundingOutpoint?.txid,
    ],
    normalizeOptionalTxid,
    'fundingTxid',
    errors,
  );
  const fundingVoutNum = Number(
    sync?.fundingOutpoint?.vout
      ?? challengeBundle?.binding?.fundingOutpoint?.vout
      ?? parallelUtxoIndex?.anchors?.fundingOutpoint?.vout
  );
  const fundingVout = Number.isInteger(fundingVoutNum) && fundingVoutNum >= 0 ? fundingVoutNum : null;
  const fundingValueSats = normalizeOptionalString(
    sync?.fundingOutpoint?.valueSats
      ?? challengeBundle?.binding?.fundingOutpoint?.valueSats
      ?? parallelUtxoIndex?.anchors?.fundingOutpoint?.valueSats
  );
  const fundingAddress = findFundingOutputAddress(parallelUtxoIndex);
  const selectedPathRecord = challengeBundle?.selectedPath || {};
  const parallelPathTx = selectedPathId ? findParallelTransaction(parallelUtxoIndex, selectedPathId) : null;
  const selectedPathTxid = pickSingleNormalizedValue(
    [
      selectedPathRecord?.txid,
      parallelPathTx?.txid,
      challengeBundle?.deltaPublication?.adaptorMapping?.cetTxid,
    ],
    normalizeOptionalTxid,
    'selectedPathTxid',
    errors,
  );
  const settlementRoute = pickSingleNormalizedValue(
    [
      sync?.settlement?.route,
      selectedPathId,
      pipeline?.options?.selectedPath,
    ],
    normalizeOptionalPathId,
    'settlementRoute',
    errors,
  );
  const settlementValidation = normalizeArtifactStepStatus(pipeline, 'settlementValidation');
  const pipelineSelectedPath = normalizeOptionalPathId(pipeline?.options?.selectedPath);
  const pipelineMode = normalizeOptionalLower(pipeline?.options?.mode);
  const nextContractId = pickSingleNormalizedValue(
    [
      challengeBundle?.deltaPublication?.rollTrigger?.nextContractId,
      fastRoll?.handoff?.publication?.rollTrigger?.nextContractId,
      fastRoll?.handoff?.nextContract?.contractId,
    ],
    normalizeOptionalString,
    'nextContractId',
    errors,
  );
  const settlementKind = normalizeOptionalString(sync?.settlement?.settlementKind);
  const operatorAddress = normalizeOptionalString(sync?.operatorAddress);
  const adminAddress = operatorAddress;
  const releaseSpendAddress = operatorAddress;
  const holderAddress = normalizeOptionalString(sync?.holderAddress);
  const oracleAddress = normalizeOptionalString(sync?.oracleAddress);
  const residualAddress = normalizeOptionalString(sync?.residualAddress);
  const fundedAmountLtc = Number(sync?.fundedAmountLtc);
  const normalizedFundedAmountLtc = Number.isFinite(fundedAmountLtc) ? Number(fundedAmountLtc.toFixed(8)) : null;
  const witnessScriptHex = normalizeOptionalLower(liveAuditedVault?.vault?.witnessScriptHex);
  const fundingScriptPubKeyHex = normalizeOptionalLower(liveAuditedVault?.vault?.fundingScriptPubKeyHex);
  const auditedFundingTxid = normalizeOptionalTxid(liveAuditedVault?.vault?.fundingTxid);

  if (!templateId) {
    errors.push('Missing templateId in procedural sync artifact.');
  }
  if (!contractId) {
    errors.push('Missing contractId in procedural sync artifact.');
  }
  if (!fundingTxid) {
    errors.push('Missing fundingTxid in referee artifacts.');
  }
  if (fundingVout === null) {
    errors.push('Missing fundingVout in referee artifacts.');
  }
  if (!selectedPathId) {
    errors.push('Missing selectedPathId in referee artifacts.');
  }
  if (!selectedPathTxid) {
    errors.push('Missing selectedPathTxid for the selected BitVM path.');
  }
  if (!fundingAddress) {
    errors.push('Missing funding output address in parallel UTXO index.');
  }
  if (!operatorAddress) {
    errors.push('Missing operatorAddress in procedural sync artifact.');
  }

  if (pipelineSelectedPath && selectedPathId && pipelineSelectedPath !== selectedPathId) {
    errors.push(`Pipeline selectedPath (${pipelineSelectedPath}) does not match challenge bundle path (${selectedPathId}).`);
  } else if (!pipelineSelectedPath && selectedPathId) {
    warnings.push(`Pipeline summary is missing selectedPath; using challenge bundle path ${selectedPathId}.`);
  }

  if (settlementValidation !== 'ok') {
    warnings.push(`Settlement validation is ${settlementValidation || 'missing'}; artifact chain is not fully validated.`);
  }

  if (!nextContractId) {
    warnings.push('Missing nextContractId for the selected BitVM path.');
  }

  warnings.push('Procedural mint is replay-only until the backend derives a fresh funded execution context per deposit.');
  warnings.push('Canonical BitVM release is disabled until wallet-server spends the current DLC/BitVM path directly.');

  if (auditedFundingTxid && fundingTxid && auditedFundingTxid !== fundingTxid) {
    warnings.push('bitvm_live_audited_vault_latest.json belongs to a different funding epoch and was ignored.');
  }

  if (selectedPathRecord?.txid && parallelPathTx?.txid) {
    const bundlePathTxid = normalizeOptionalTxid(selectedPathRecord.txid);
    const parallelPathTxid = normalizeOptionalTxid(parallelPathTx.txid);
    if (bundlePathTxid && parallelPathTxid && bundlePathTxid !== parallelPathTxid) {
      errors.push(`Selected path txid mismatch between challenge bundle (${bundlePathTxid}) and parallel index (${parallelPathTxid}).`);
    }
  }

  if (selectedPathId && parallelPathTx && fundingTxid) {
    const spendsFundingTxid = normalizeOptionalTxid(parallelPathTx?.spendsOutpoint?.txid);
    if (spendsFundingTxid && spendsFundingTxid !== fundingTxid) {
      errors.push(`Selected path ${selectedPathId} spends ${spendsFundingTxid}, expected funding txid ${fundingTxid}.`);
    }
  }

  const receiptTicker = chainTicker ? `r${chainTicker}-SAT` : null;
  const replayOnly = true;
  const releaseReady = false;
  const contextId = chainId && fundingTxid && selectedPathId
    ? `${chainId}:${fundingTxid}:${selectedPathId}`
    : null;
  const contextHash = contextId
    ? crypto
      .createHash('sha256')
      .update(
        executionContextHashPayload({
          chainId,
          templateId,
          contractId,
          fundingTxid,
          fundingVout,
          selectedPathId,
          selectedPathTxid,
          receiptPropertyId,
          settlementRoute,
        })
      )
      .digest('hex')
    : null;

  return {
    ready: errors.length === 0,
    validationReady: settlementValidation === 'ok',
    contextId,
    contextHash,
    artifactDir: getRefereeArtifactsDir(),
    chainId,
    chainTicker,
    state: normalizeOptionalString(sync?.state),
    receiptPropertyId,
    receiptTicker,
    templateId,
    templateHash,
    contractId,
    fundingTxid,
    fundingVout,
    fundingValueLtc: toRoundedLtcFromSats(fundingValueSats),
    fundingValueSats,
    fundingAddress,
    vaultAddress: fundingAddress,
    releaseSpendAddress,
    adminAddress,
    holderAddress,
    operatorAddress,
    oracleAddress,
    residualAddress,
    settlementRoute,
    settlementKind,
    selectedPathId,
    selectedPathTxid,
    nextContractId,
    pipelineMode,
    pipelineSelectedPath,
    settlementValidation,
    witnessScriptHex: auditedFundingTxid && auditedFundingTxid === fundingTxid ? witnessScriptHex : null,
    fundingScriptPubKeyHex: auditedFundingTxid && auditedFundingTxid === fundingTxid ? fundingScriptPubKeyHex : null,
    fundedAmountLtc: normalizedFundedAmountLtc,
    replayOnly,
    releaseReady,
    sourceArtifacts: {
      proceduralSync: compactArtifactSummary(sync),
      pipeline: compactArtifactSummary(pipeline),
      parallelUtxoIndex: compactArtifactSummary(parallelUtxoIndex),
      challengeBundle: compactArtifactSummary(challengeBundle),
      fastRoll: compactArtifactSummary(fastRoll),
      liveAuditedVault: compactArtifactSummary(liveAuditedVault),
    },
    warnings,
    errors,
  };
}

function buildProceduralConfig(artifacts: RefereeArtifacts): AnyObj | null {
  const sync = artifacts.proceduralSync;
  const executionContext = artifacts.executionContext;
  if (!sync && !executionContext) {
    return null;
  }

  const chainId = executionContext?.chainId || inferProceduralChainId(sync);
  const chainTicker = inferChainTicker(chainId);
  const receiptPropertyId = Number(executionContext?.receiptPropertyId || sync?.propertyId || 0);
  const config = {
    enabled: true,
    ready: !!executionContext?.ready,
    artifactDir: getRefereeArtifactsDir(),
    chainId,
    chainTicker,
    state: executionContext?.state || sync?.state || null,
    receiptPropertyId: Number.isFinite(receiptPropertyId) && receiptPropertyId > 0 ? receiptPropertyId : undefined,
    receiptTicker: executionContext?.receiptTicker || (chainTicker ? `r${chainTicker}-SAT` : null),
    collateralPropertyId: Number(process.env.BITVM_COLLATERAL_PROPERTY_ID || 1),
    adminAddress: executionContext?.adminAddress || sync?.operatorAddress || null,
    vaultAddress: executionContext?.vaultAddress || null,
    fundingAddress: executionContext?.fundingAddress || null,
    releaseSpendAddress: executionContext?.releaseSpendAddress || sync?.operatorAddress || null,
    holderAddress: executionContext?.holderAddress || sync?.holderAddress || null,
    operatorAddress: executionContext?.operatorAddress || sync?.operatorAddress || null,
    oracleAddress: executionContext?.oracleAddress || sync?.oracleAddress || null,
    residualAddress: executionContext?.residualAddress || sync?.residualAddress || null,
    templateId: executionContext?.templateId || sync?.templateId || null,
    templateHash: executionContext?.templateHash || sync?.templateHash || null,
    contractId: executionContext?.contractId || sync?.contractId || null,
    mintSettlementState: 'FUNDED',
    redeemSettlementState: 'SETTLED',
    fundingTxid: executionContext?.fundingTxid || sync?.fundingTxid || null,
    fundingVout: executionContext?.fundingVout ?? sync?.fundingOutpoint?.vout ?? null,
    fundedAmountLtc: executionContext?.fundedAmountLtc ?? sync?.fundedAmountLtc ?? null,
    settlementRoute: executionContext?.settlementRoute || sync?.settlement?.route || null,
    settlementKind: executionContext?.settlementKind || sync?.settlement?.settlementKind || null,
    selectedPathId: executionContext?.selectedPathId || null,
    selectedPathTxid: executionContext?.selectedPathTxid || null,
    nextContractId: executionContext?.nextContractId || null,
    pipelineMode: executionContext?.pipelineMode || null,
    pipelineSelectedPath: executionContext?.pipelineSelectedPath || null,
    settlementValidation: executionContext?.settlementValidation || null,
    executionContextReady: !!executionContext?.ready,
    executionContextId: executionContext?.contextId || null,
    executionContextHash: executionContext?.contextHash || null,
    validationReady: !!executionContext?.validationReady,
    replayOnly: executionContext?.replayOnly ?? true,
    releaseReady: !!executionContext?.releaseReady,
    contextWarnings: executionContext?.warnings || [],
    contextErrors: executionContext?.errors || [],
    witnessScriptHex: executionContext?.witnessScriptHex || null,
    fundingScriptPubKeyHex: executionContext?.fundingScriptPubKeyHex || null,
  };

  return config;
}

function getRefereeArtifacts(): RefereeArtifacts {
  const proceduralSync = loadArtifactJson(PROCEDURAL_SYNC_FILE);
  const pipeline = loadArtifactJson(PIPELINE_FILE);
  const parallelUtxoIndex = loadArtifactJson(PARALLEL_UTXO_FILE);
  const challengeBundle = loadArtifactJson(CHALLENGE_BUNDLE_FILE);
  const fastRoll = loadArtifactJson(FAST_ROLL_FILE);
  const liveAuditedVault = loadArtifactJson(LIVE_AUDITED_VAULT_FILE);
  const executionContext = buildExecutionContext({
    proceduralSync,
    pipeline,
    parallelUtxoIndex,
    challengeBundle,
    fastRoll,
    liveAuditedVault,
  });
  const artifacts = {
    proceduralSync,
    pipeline,
    parallelUtxoIndex,
    challengeBundle,
    fastRoll,
    liveAuditedVault,
    executionContext,
    proceduralConfig: null,
  };
  const proceduralConfig = buildProceduralConfig(artifacts);
  return {
    ...artifacts,
    proceduralConfig,
  };
}

function normalizeBooleanInput(value: any, fallback: boolean): boolean {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function resolveRequestedPipelineMode(value: any): 'fresh' | 'replay' {
  const normalized = String(value || 'fresh').trim().toLowerCase();
  return normalized === 'replay' ? 'replay' : 'fresh';
}

function resolveRequestedPathName(value: any): string {
  const normalized = String(value || 'roll').trim().toLowerCase();
  return normalized || 'roll';
}

function resolveMinConfirmations(value: any): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function resolveBitvmRpcConfig(request: BitvmArtifactGenerationRequest = {}): BitvmRpcConfig {
  const rawUrl = normalizeOptionalString(request.rpcUrl)
    || normalizeOptionalString(process.env.BITVM_RPC_URL)
    || 'http://127.0.0.1:19332';
  const parsedUrl = new URL(rawUrl);
  const port = Number(parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80));
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid BitVM RPC URL: ${rawUrl}`);
  }

  return {
    url: `${parsedUrl.protocol}//${parsedUrl.host}`,
    username: normalizeOptionalString(request.rpcUser)
      || normalizeOptionalString(process.env.BITVM_RPC_USER)
      || 'user',
    password: normalizeOptionalString(request.rpcPass)
      || normalizeOptionalString(process.env.BITVM_RPC_PASS)
      || 'pass',
    host: parsedUrl.hostname,
    port,
    sourceWallet: normalizeOptionalString(request.sourceWallet)
      || normalizeOptionalString(process.env.BITVM_SOURCE_WALLET)
      || 'tl',
    destinationWallet: normalizeOptionalString(request.destinationWallet)
      || normalizeOptionalString(process.env.BITVM_WALLET)
      || 'tl-wallet',
    minConfirmations: resolveMinConfirmations(request.minConfirmations ?? process.env.DLC_MIN_CONFIRMATIONS),
  };
}

function createBitvmRpcClient(config: BitvmRpcConfig) {
  return new RpcClient({
    username: config.username,
    password: config.password,
    host: config.host,
    port: config.port,
    timeout: 10000,
  });
}

async function ensureBitvmRpcClient(config: BitvmRpcConfig) {
  if (fasitfyServer.rpcClient && Number(fasitfyServer.rpcPort || 0) === config.port) {
    const existingCheck = await fasitfyServer.rpcClient.call('getblockchaininfo');
    if (existingCheck?.data) {
      return {
        client: fasitfyServer.rpcClient,
        blockchainInfo: existingCheck.data,
      };
    }
  }

  const client = createBitvmRpcClient(config);
  const check = await client.call('getblockchaininfo');
  if (!check?.data) {
    throw new Error(`BitVM RPC is not reachable at ${config.url}.`);
  }

  fasitfyServer.rpcClient = client;
  fasitfyServer.rpcPort = config.port;
  return {
    client,
    blockchainInfo: check.data,
  };
}

async function postBitvmRpc(
  config: BitvmRpcConfig,
  method: string,
  params: any[] = [],
  walletName?: string | null,
) {
  const baseUrl = trimSlash(config.url);
  const endpoint = walletName
    ? `${baseUrl}/wallet/${encodeURIComponent(String(walletName))}`
    : `${baseUrl}/`;
  try {
    const { data } = await axios.post(
      endpoint,
      {
        jsonrpc: '1.0',
        id: 'wallet-server-bitvm',
        method,
        params,
      },
      {
        auth: {
          username: config.username,
          password: config.password,
        },
        timeout: 15000,
      }
    );

    if (data?.error) {
      const message = data?.error?.message || JSON.stringify(data.error);
      throw new Error(message);
    }

    return data?.result;
  } catch (error: any) {
    const statusMessage = error?.response?.data?.error?.message || error?.message || 'unknown error';
    throw new Error(`RPC ${method} failed: ${statusMessage}`);
  }
}

async function ensureWalletLoaded(config: BitvmRpcConfig, walletName: string) {
  const loadedWallets = await postBitvmRpc(config, 'listwallets', []);
  const loaded = Array.isArray(loadedWallets) ? loadedWallets.map((item: any) => String(item)) : [];
  if (loaded.includes(walletName)) {
    return { walletName, alreadyLoaded: true };
  }

  const result = await postBitvmRpc(config, 'loadwallet', [walletName]);
  return {
    walletName,
    alreadyLoaded: false,
    result,
  };
}

function extractCompleteRoleSetTags(labels: any[]): string[] {
  const requiredRoles = ['operator', 'oracle', 'alice', 'bob', 'residual'];
  const roleSets = new Map<string, Set<string>>();

  for (const labelValue of Array.isArray(labels) ? labels : []) {
    const label = String(labelValue || '').trim();
    const match = label.match(/^(.*)-(operator|oracle|alice|bob|residual)$/i);
    if (!match) {
      continue;
    }
    const tag = String(match[1] || '').trim();
    const role = String(match[2] || '').trim().toLowerCase();
    if (!tag) {
      continue;
    }
    if (!roleSets.has(tag)) {
      roleSets.set(tag, new Set<string>());
    }
    roleSets.get(tag)?.add(role);
  }

  return Array.from(roleSets.entries())
    .filter(([, roles]) => requiredRoles.every((role) => roles.has(role)))
    .map(([tag]) => tag)
    .sort((left, right) => right.localeCompare(left));
}

function parseJsonDocument(raw: string): AnyObj | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {}

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  return null;
}

function runCommand(command: string, args: string[], options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CommandRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      reject(error);
    });
    child.on('close', (code) => {
      const exitCode = Number(code ?? -1);
      const result = {
        command,
        args,
        cwd: options.cwd,
        exitCode,
        stdout,
        stderr,
      };
      if (exitCode !== 0) {
        const stderrTail = compactOutput(stderr || stdout, 30).join('\n');
        reject(new Error(`${command} exited with code ${exitCode}.${stderrTail ? `\n${stderrTail}` : ''}`));
        return;
      }
      resolve(result);
    });
  });
}

function trimSlash(url: string): string {
  return String(url || '').replace(/\/+$/, '');
}

function ensurePositiveLtcAmount(amount: number | string, fieldName: string): number {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive LTC amount`);
  }
  return Number(parsed.toFixed(8));
}

function toSatsBase36(amountLtc: number | string): string {
  const sats = Math.round(Number(amountLtc) * 1e8);
  if (!Number.isFinite(sats) || sats <= 0) {
    throw new Error('amount must convert to a positive satoshi value');
  }
  return sats.toString(36);
}

function encodeGrantManagedTokenPayload(params: {
  propertyId: number;
  amountLtc: number | string;
  recipientAddress: string;
  dlcTemplateId?: string | null;
  dlcContractId?: string | null;
  settlementState?: string | null;
  dlcHash?: string | null;
}) {
  return `tl${(11).toString(36)}${
    [
      Number(params.propertyId).toString(36),
      toSatsBase36(params.amountLtc),
      params.recipientAddress || '',
      '',
      params.dlcTemplateId || '',
      params.dlcContractId || '',
      params.settlementState || '',
      params.dlcHash || '',
    ].join(',')
  }`;
}

function ensureNonEmptyAddress(value: string, fieldName: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

async function listSpendableUtxos(address: string) {
  if (!fasitfyServer.rpcClient) {
    throw new Error('No wallet RPC client initialized for procedural execution.');
  }

  const list = rpcRequireData(
    await fasitfyServer.rpcClient.call('listunspent', 0, 999999999, [address]),
    'listunspent',
  );

  return (Array.isArray(list) ? list : [])
    .filter((utxo: AnyObj) => Number(utxo?.amount || 0) > 0 && String(utxo?.txid || '').length > 0)
    .sort((a: AnyObj, b: AnyObj) => Number(b.amount || 0) - Number(a.amount || 0));
}

function selectSpendableInputs(utxos: AnyObj[], requiredLtc: number) {
  const selected: AnyObj[] = [];
  let total = 0;

  for (const utxo of utxos) {
    selected.push(utxo);
    total = Number((total + Number(utxo.amount || 0)).toFixed(8));
    if (total >= requiredLtc) {
      break;
    }
  }

  if (total < requiredLtc) {
    throw new Error(`Insufficient spendable balance for procedural execution: need ${requiredLtc}, found ${total}`);
  }

  return { selected, total };
}

async function createAndBroadcastRawSpend(params: {
  senderAddress: string;
  recipientAddress: string;
  amountLtc: number;
  feeLtc: number;
  payload?: string | null;
}) {
  const senderAddress = ensureNonEmptyAddress(params.senderAddress, 'senderAddress');
  const recipientAddress = ensureNonEmptyAddress(params.recipientAddress, 'recipientAddress');
  const amountLtc = ensurePositiveLtcAmount(params.amountLtc, 'amount');
  const feeLtc = ensurePositiveLtcAmount(params.feeLtc, 'fee');
  const utxos = await listSpendableUtxos(senderAddress);
  const { selected, total } = selectSpendableInputs(utxos, Number((amountLtc + feeLtc).toFixed(8)));

  const changeLtc = Number((total - amountLtc - feeLtc).toFixed(8));
  if (changeLtc < 0) {
    throw new Error('Insufficient funds after fee calculation');
  }

  const outputs: Record<string, number> = {};
  outputs[recipientAddress] = amountLtc;
  if (changeLtc > 0) {
    outputs[senderAddress] = Number(((outputs[senderAddress] || 0) + changeLtc).toFixed(8));
  }

  const inputs = selected.map((utxo: AnyObj) => ({
    txid: String(utxo.txid),
    vout: Number(utxo.vout),
  }));

  let rawTx = rpcRequireData(
    await fasitfyServer.rpcClient.call('createrawtransaction', inputs, outputs),
    'createrawtransaction',
  );

  if (params.payload) {
    rawTx = rpcRequireData(
      await fasitfyServer.rpcClient.call('tl_createrawtx_opreturn', rawTx, params.payload),
      'tl_createrawtx_opreturn',
    );
  }

  const signed = rpcRequireData(
    await fasitfyServer.rpcClient.call('signrawtransactionwithwallet', rawTx),
    'signrawtransactionwithwallet',
  );
  if (!signed?.hex || signed?.complete !== true) {
    throw new Error('signrawtransactionwithwallet returned incomplete signature set.');
  }

  return rpcRequireData(
    await fasitfyServer.rpcClient.call('sendrawtransaction', signed.hex),
    'sendrawtransaction',
  );
}

function emitBitvmSocket(event: string, payload: AnyObj) {
  try {
    fasitfyServer?.mainSocketService?.emit(event, payload);
  } catch {}
}

function requireApiUrl(): string {
  const base = String(fasitfyServer.relayerApiUrl || '').trim();
  if (!base) {
    throw new Error('BitVM status source is not configured. Set API URL in wallet first.');
  }
  return trimSlash(base);
}

function assertExecutionContextReady(context: BitvmExecutionContext | null): BitvmExecutionContext {
  if (!context) {
    throw new Error('Canonical BitVM execution context is unavailable.');
  }
  if (!context.ready) {
    const details = context.errors.length
      ? ` ${context.errors.join(' ')}`
      : '';
    throw new Error(`Canonical BitVM execution context is not ready.${details}`.trim());
  }
  return context;
}

function assertExecutionContextExpectation(context: BitvmExecutionContext, request: ProceduralExecutionRequest) {
  const expectations = [
    {
      label: 'executionContextId',
      expected: normalizeOptionalString(request.expectedExecutionContextId),
      actual: context.contextId,
    },
    {
      label: 'executionContextHash',
      expected: normalizeOptionalLower(request.expectedExecutionContextHash),
      actual: normalizeOptionalLower(context.contextHash),
    },
    {
      label: 'fundingTxid',
      expected: normalizeOptionalTxid(request.expectedFundingTxid),
      actual: context.fundingTxid,
    },
    {
      label: 'selectedPathId',
      expected: normalizeOptionalPathId(request.expectedSelectedPathId),
      actual: context.selectedPathId,
    },
    {
      label: 'templateId',
      expected: normalizeOptionalString(request.expectedTemplateId),
      actual: context.templateId,
    },
    {
      label: 'contractId',
      expected: normalizeOptionalString(request.expectedContractId),
      actual: context.contractId,
    },
  ];

  for (const expectation of expectations) {
    if (!expectation.expected) {
      continue;
    }
    if (expectation.expected !== expectation.actual) {
      throw new Error(
        `Expected ${expectation.label} ${expectation.expected}, current context is ${expectation.actual || 'missing'}.`
      );
    }
  }
}

function assertCanonicalFundingReference(
  context: BitvmExecutionContext,
  request: ProceduralExecutionRequest,
  amountLtc: number
) {
  const depositTxid = normalizeOptionalTxid(request.depositTxid);
  if (!depositTxid) {
    throw new Error('Procedural mint requires the canonical funding txid as depositTxid.');
  }
  if (!context.fundingTxid) {
    throw new Error('Canonical BitVM funding txid is unavailable.');
  }
  if (depositTxid !== context.fundingTxid) {
    throw new Error(
      `Procedural mint only supports canonical funding txid ${context.fundingTxid}; received ${depositTxid}.`
    );
  }

  const canonicalAmountLtc = normalizeLtcAmount(context.fundedAmountLtc);
  if (canonicalAmountLtc === null) {
    throw new Error('Canonical funded amount is unavailable for procedural mint.');
  }
  if (!sameLtcAmount(amountLtc, canonicalAmountLtc)) {
    throw new Error(
      `Procedural mint amount must match canonical funded amount ${canonicalAmountLtc.toFixed(8)} LTC.`
    );
  }
}

function assertCanonicalReleaseDisabled(context: BitvmExecutionContext) {
  if (!context.releaseReady) {
    throw new Error(
      'Canonical BitVM release is disabled. The backend will not broadcast a generic wallet spend in place of the current DLC/BitVM path.'
    );
  }

  throw new Error('Canonical BitVM release construction is not implemented in wallet-server yet.');
}

function proceduralContextSummary(context: BitvmExecutionContext) {
  return {
    id: context.contextId,
    hash: context.contextHash,
    chainId: context.chainId,
    templateId: context.templateId,
    contractId: context.contractId,
    fundingTxid: context.fundingTxid,
    fundingVout: context.fundingVout,
    selectedPathId: context.selectedPathId,
    selectedPathTxid: context.selectedPathTxid,
    settlementRoute: context.settlementRoute,
    settlementKind: context.settlementKind,
    nextContractId: context.nextContractId,
    depositAddress: context.vaultAddress,
    releaseSpendAddress: context.releaseSpendAddress,
    replayOnly: context.replayOnly,
    releaseReady: context.releaseReady,
    validationReady: context.validationReady,
    settlementValidation: context.settlementValidation,
    warnings: context.warnings,
  };
}

function normalizeStatus(raw: AnyObj): AnyObj {
  const status = raw || {};
  const challenge = status.challenge || {};
  const cache = status.cache || {};
  const sweep = status.sweep || {};
  const hooks = status.hooks || {};
  const procedural = status.procedural || {};
  const pipeline = status.pipeline || {};
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
      expiringTargets: Array.isArray(challenge.expiringTargets) ? challenge.expiringTargets : [],
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
    },
    procedural: {
      ready: !!procedural.ready,
      state: procedural.state || null,
      chainId: procedural.chainId || null,
      receiptPropertyId: Number(procedural.receiptPropertyId || 0),
      receiptTicker: procedural.receiptTicker || null,
      templateId: procedural.templateId || null,
      contractId: procedural.contractId || null,
      fundingTxid: procedural.fundingTxid || null,
      fundingVout: Number.isInteger(Number(procedural.fundingVout)) ? Number(procedural.fundingVout) : null,
      fundedAmountLtc: procedural.fundedAmountLtc ?? null,
      settlementRoute: procedural.settlementRoute || null,
      settlementKind: procedural.settlementKind || null,
      selectedPathId: procedural.selectedPathId || null,
      selectedPathTxid: procedural.selectedPathTxid || null,
      nextContractId: procedural.nextContractId || null,
      executionContextId: procedural.executionContextId || null,
      executionContextHash: procedural.executionContextHash || null,
      executionContextReady: !!procedural.executionContextReady,
      validationReady: !!procedural.validationReady,
      replayOnly: !!procedural.replayOnly,
      releaseReady: !!procedural.releaseReady,
      settlementValidation: procedural.settlementValidation || null,
      fundingAddress: procedural.fundingAddress || null,
      releaseSpendAddress: procedural.releaseSpendAddress || null,
      contextWarnings: Array.isArray(procedural.contextWarnings) ? procedural.contextWarnings : [],
      contextErrors: Array.isArray(procedural.contextErrors) ? procedural.contextErrors : [],
    },
    pipeline: {
      status: pipeline.status || null,
      mode: pipeline.mode || pipeline.options?.mode || null,
      selectedPath: pipeline.selectedPath || pipeline.options?.selectedPath || null,
      settlementValidation: pipeline.settlementValidation || null,
    },
  };
}

export async function fetchBitvmStatus(query?: { propertyId?: number; dlcRef?: string }) {
  const artifacts = getRefereeArtifacts();
  const body: AnyObj = {};
  if (query && Number.isFinite(query.propertyId) && Number(query.propertyId) > 0) {
    body.propertyId = Number(query.propertyId);
  }
  if (query?.dlcRef) {
    body.dlcRef = String(query.dlcRef).trim();
  }

  let remote: AnyObj = {};
  try {
    const base = requireApiUrl();
    const { data } = await axios.post(`${base}/tl_bitvmStatus`, body, { timeout: 7000 });
    remote = data || {};
  } catch (_err) {
    remote = {
      source: 'walletArtifacts',
      featureEnabled: false,
      commitScheme: 'legacy-merkle',
      updatedAt: Date.now(),
    };
  }

  return normalizeStatus({
    ...remote,
    procedural: {
      ready: artifacts.proceduralConfig?.ready === true,
      ...(artifacts.proceduralConfig || {}),
    },
    pipeline: {
      status: artifacts.pipeline?.status || null,
      mode: artifacts.pipeline?.options?.mode || null,
      selectedPath: artifacts.pipeline?.options?.selectedPath || null,
      settlementValidation: artifacts.pipeline?.summary?.settlementValidation?.status
        || artifacts.pipeline?.steps?.find?.((step: AnyObj) => step?.id === 'settlementValidation')?.status
        || null,
    },
  });
}

export function getBitvmProceduralSync() {
  return getRefereeArtifacts().proceduralSync;
}

export function getBitvmPipelineSummary() {
  return getRefereeArtifacts().pipeline;
}

export function getBitvmProceduralConfig() {
  return getRefereeArtifacts().proceduralConfig;
}

export function getBitvmExecutionContext() {
  return getRefereeArtifacts().executionContext;
}

export async function generateBitvmArtifacts(request: BitvmArtifactGenerationRequest = {}) {
  const refereeRootDir = getRefereeRootDir();
  const provisionScriptPath = path.resolve(refereeRootDir, path.basename(DEFAULT_PROVISION_SCRIPT_PATH));
  const pipelineScriptPath = path.resolve(refereeRootDir, path.basename(DEFAULT_PIPELINE_SCRIPT_PATH));
  if (!fs.existsSync(provisionScriptPath)) {
    throw new Error(`BitVM provision script not found: ${provisionScriptPath}`);
  }
  if (!fs.existsSync(pipelineScriptPath)) {
    throw new Error(`BitVM pipeline script not found: ${pipelineScriptPath}`);
  }

  const rpcConfig = resolveBitvmRpcConfig(request);
  const { blockchainInfo } = await ensureBitvmRpcClient(rpcConfig);
  const sourceWallet = await ensureWalletLoaded(rpcConfig, rpcConfig.sourceWallet);
  const destinationWallet = await ensureWalletLoaded(rpcConfig, rpcConfig.destinationWallet);

  const labelsBefore = await postBitvmRpc(rpcConfig, 'listlabels', [], rpcConfig.destinationWallet);
  const roleSetTagsBefore = extractCompleteRoleSetTags(labelsBefore);
  const provisionIfMissing = normalizeBooleanInput(request.provisionIfMissing, true);

  let provision: AnyObj | null = null;
  if (roleSetTagsBefore.length === 0) {
    if (!provisionIfMissing) {
      throw new Error(`No complete m1 role-set labels found in wallet ${rpcConfig.destinationWallet}.`);
    }

    const provisionRun = await runCommand(
      process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      [
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        provisionScriptPath,
        '-RpcUrl',
        rpcConfig.url,
        '-RpcUser',
        rpcConfig.username,
        '-RpcPass',
        rpcConfig.password,
        '-SourceWallet',
        rpcConfig.sourceWallet,
        '-DestinationWallet',
        rpcConfig.destinationWallet,
      ],
      { cwd: refereeRootDir }
    );
    provision = {
      ...(parseJsonDocument(provisionRun.stdout) || {}),
      stdoutTail: compactOutput(provisionRun.stdout, 30),
      stderrTail: compactOutput(provisionRun.stderr, 30),
    };
  }

  const labelsAfter = await postBitvmRpc(rpcConfig, 'listlabels', [], rpcConfig.destinationWallet);
  const roleSetTagsAfter = extractCompleteRoleSetTags(labelsAfter);
  if (roleSetTagsAfter.length === 0) {
    throw new Error(`No complete m1 role-set labels are available in wallet ${rpcConfig.destinationWallet}.`);
  }

  const mode = resolveRequestedPipelineMode(request.mode);
  const pathName = resolveRequestedPathName(request.pathName);
  const broadcastFunding = normalizeBooleanInput(request.broadcastFunding, false);
  const includeSettlementValidation = normalizeBooleanInput(request.includeSettlementValidation, true);
  const forceSettlementValidation = normalizeBooleanInput(request.forceSettlementValidation, false);
  const nodeExe = normalizeOptionalString(process.env.BITVM_NODE_EXE) || 'node';

  const pipelineRun = await runCommand(
    nodeExe,
    [pipelineScriptPath],
    {
      cwd: refereeRootDir,
      env: {
        ...process.env,
        BITVM_RPC_URL: rpcConfig.url,
        BITVM_RPC_USER: rpcConfig.username,
        BITVM_RPC_PASS: rpcConfig.password,
        BITVM_WALLET: rpcConfig.destinationWallet,
        DLC_MIN_CONFIRMATIONS: String(rpcConfig.minConfirmations),
        M1_PIPELINE_MODE: mode,
        M1_PATH_NAME: pathName,
        M1_BROADCAST_FUNDING: broadcastFunding ? '1' : '0',
        M1_INCLUDE_SETTLEMENT_VALIDATION: includeSettlementValidation ? '1' : '0',
        M1_FORCE_SETTLEMENT_VALIDATION: forceSettlementValidation ? '1' : '0',
      },
    }
  );

  const artifacts = getRefereeArtifacts();
  const draftArtifact = loadArtifactJson('m1_dlc_draft_latest.json');
  const fundingFinalArtifact = loadArtifactJson('m1_funding_finalized_latest.json');

  return {
    rpc: {
      url: rpcConfig.url,
      host: rpcConfig.host,
      port: rpcConfig.port,
      sourceWallet: rpcConfig.sourceWallet,
      destinationWallet: rpcConfig.destinationWallet,
      minConfirmations: rpcConfig.minConfirmations,
      chain: normalizeOptionalString(blockchainInfo?.chain),
      blocks: Number(blockchainInfo?.blocks || 0),
      headers: Number(blockchainInfo?.headers || 0),
      initialBlockDownload: !!blockchainInfo?.initialblockdownload,
    },
    wallets: {
      source: sourceWallet,
      destination: destinationWallet,
      roleSetTagsBefore,
      roleSetTagsAfter,
    },
    provision,
    pipelineRun: {
      mode,
      pathName,
      broadcastFunding,
      includeSettlementValidation,
      forceSettlementValidation,
      stdoutTail: compactOutput(pipelineRun.stdout, 40),
      stderrTail: compactOutput(pipelineRun.stderr, 40),
    },
    latestDraft: {
      tag: normalizeOptionalString(draftArtifact?.tag),
      eventId: normalizeOptionalString(draftArtifact?.eventId),
    },
    latestFunding: {
      fundingTxid: normalizeOptionalTxid(fundingFinalArtifact?.fundingTxid),
      broadcastAttempted: !!fundingFinalArtifact?.broadcast?.attempted,
      broadcastSent: !!fundingFinalArtifact?.broadcast?.sent,
    },
    executionContext: artifacts.executionContext,
    proceduralConfig: artifacts.proceduralConfig,
    pipeline: artifacts.pipeline,
  };
}

export async function bitvmProceduralMint(request: ProceduralExecutionRequest) {
  const artifacts = getRefereeArtifacts();
  const context = assertExecutionContextReady(artifacts.executionContext);
  assertExecutionContextExpectation(context, request);
  const config = artifacts.proceduralConfig;
  if (!config) {
    throw new Error('Procedural BitVM config is unavailable.');
  }

  const senderAddress = ensureNonEmptyAddress(context.adminAddress || context.operatorAddress, 'adminAddress');
  const recipientAddress = ensureNonEmptyAddress(request.recipientAddress, 'recipientAddress');
  const amountLtc = ensurePositiveLtcAmount(request.amount, 'amount');
  assertCanonicalFundingReference(context, request, amountLtc);
  const propertyId = Number(context.receiptPropertyId || config.receiptPropertyId || 0);
  if (!Number.isFinite(propertyId) || propertyId <= 0) {
    throw new Error('Procedural receipt property id is not configured.');
  }

  const payload = encodeGrantManagedTokenPayload({
    propertyId,
    amountLtc,
    recipientAddress,
    dlcTemplateId: context.templateId,
    dlcContractId: context.contractId,
    settlementState: config.mintSettlementState,
    dlcHash: context.templateHash,
  });

  const mintAmountLtc = Number(process.env.BITVM_PROCEDURAL_MINT_DUST_LTC || 0.0000056);
  const txFeeLtc = Number(process.env.BITVM_PROCEDURAL_TX_FEE_LTC || 0.0003);
  const mintTxid = await createAndBroadcastRawSpend({
    senderAddress,
    recipientAddress,
    amountLtc: mintAmountLtc,
    feeLtc: txFeeLtc,
    payload,
  });

  return {
    mintTxid,
    depositTxid: request.depositTxid || null,
    recipientAddress,
    amount: amountLtc,
    propertyId,
    contractId: context.contractId || null,
    templateId: context.templateId || null,
    fundingTxid: context.fundingTxid || null,
    selectedPathId: context.selectedPathId || null,
    executionContext: proceduralContextSummary(context),
  };
}

export async function bitvmProceduralRelease(request: ProceduralExecutionRequest) {
  const artifacts = getRefereeArtifacts();
  const context = assertExecutionContextReady(artifacts.executionContext);
  assertExecutionContextExpectation(context, request);
  assertCanonicalReleaseDisabled(context);
}

function canonicalRelayMessage(bundle: AnyObj): string {
  return JSON.stringify({
    eventId: String(bundle.eventId || ''),
    outcome: String(bundle.outcome || ''),
    outcomeIndex: Number(bundle.outcomeIndex || 0),
    stateHash: String(bundle.stateHash || ''),
    timestamp: Number(bundle.timestamp || 0),
  });
}

function sha256(buf: Buffer): Buffer {
  return crypto.createHash('sha256').update(buf).digest();
}

function toBase36Amount(amount: number): string {
  const sats = Math.floor(Math.max(0, Number(amount || 0)) * 1e8);
  return sats.toString(36);
}

function encodeStakeFraudProofPayload(params: {
  action: number;
  oracleId: number;
  stakedPropertyId: number;
  amount: number;
  accusedAddress?: string;
  evidenceHash?: string;
  relayType: number;
  stateHash: string;
  dlcRef?: string;
  settlementState?: string;
  relayBlob?: string;
  autoRoll?: boolean;
  nextDlcRef?: string;
}): string {
  const type30 = Number(30).toString(36);
  return `tl${type30}` + [
    Number(params.action || 0).toString(36),
    Number(params.oracleId || 0).toString(36),
    Number(params.stakedPropertyId || 0).toString(36),
    toBase36Amount(params.amount || 0),
    String(params.accusedAddress || ''),
    String(params.evidenceHash || ''),
    Number(params.relayType || 0).toString(36),
    String(params.stateHash || ''),
    String(params.dlcRef || ''),
    String(params.settlementState || ''),
    String(params.relayBlob || ''),
    params.autoRoll ? '1' : '0',
    String(params.nextDlcRef || ''),
  ].join(',');
}

function randomPrivateKey(): Buffer {
  for (;;) {
    const key = crypto.randomBytes(32);
    if (secp.isPrivate(key)) return key;
  }
}

function buildRelayBlob(settlement: AnyObj, stateHash: string): string {
  const privKey = randomPrivateKey();
  const pubkey = Buffer.from(secp.pointFromScalar(privKey, true) as Uint8Array).toString('hex');
  const payload = {
    eventId: `wallet-bitvm-watchtower-${Date.now()}`,
    outcome: 'DISPUTED',
    outcomeIndex: 0,
    stateHash,
    timestamp: Date.now(),
    settlement,
    oraclePubkeyHex: pubkey,
  };
  const msgHash = sha256(Buffer.from(canonicalRelayMessage(payload), 'utf8'));
  const signatureHex = Buffer.from(secp.sign(msgHash, privKey)).toString('hex');
  const full = { ...payload, signatureHex };
  return `b64:${Buffer.from(JSON.stringify(full), 'utf8').toString('base64')}`;
}

async function postListener(path: string, body: AnyObj): Promise<any> {
  const base = requireApiUrl();
  const { data } = await axios.post(`${base}${path}`, body, { timeout: 10000 });
  return data;
}

function pickExpiringTarget(status: AnyObj, query?: WatchtowerQuery): ExpiringTarget | null {
  const targets = (status?.challenge?.expiringTargets || []) as ExpiringTarget[];
  if (!Array.isArray(targets) || targets.length === 0) return null;
  const requestedCacheId = String(query?.cacheId || '').trim();
  if (requestedCacheId) {
    const match = targets.find((t) => String(t.cacheId) === requestedCacheId);
    return match || null;
  }
  return [...targets].sort((a, b) => Number(a.challengeDeadlineBlock || 0) - Number(b.challengeDeadlineBlock || 0))[0] || null;
}

function rpcRequireData(result: any, method: string): any {
  if (!result || result.error || result.data === undefined || result.data === null) {
    throw new Error(`${method}: ${result?.error || 'empty result'}`);
  }
  return result.data;
}

async function resolveOracleAdminAddress(oracleId: number): Promise<string> {
  const fromEnv = String(process.env.BITVM_ORACLE_ADMIN_ADDRESS || '').trim();
  if (fromEnv) return fromEnv;
  const all = await postListener('/tl_listOracles', {});
  const arr = Array.isArray(all) ? all : [];
  const row = arr.find((o: AnyObj) => Number(o?.id) === Number(oracleId) || Number(o?._id) === Number(oracleId) || Number(o?.oracleid) === Number(oracleId));
  const admin = String(row?.adminAddress || row?.name?.adminAddress || '').trim();
  if (!admin) {
    throw new Error(`Oracle admin address not found for oracleId=${oracleId}. Set BITVM_ORACLE_ADMIN_ADDRESS.`);
  }
  return admin;
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
  emitBitvmSocket('bitvm-watchtower-update', {
    status,
    watchtower: getBitvmWatchtowerStatus(),
    at: Date.now(),
  });
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
  emitBitvmSocket('bitvm-watchtower-update', { watchtower: getBitvmWatchtowerStatus(), at: Date.now() });
  WATCHTOWER.timer = setInterval(() => {
    runWatchtowerScanOnce().catch((err: any) => {
      WATCHTOWER.lastError = err?.message || String(err || 'watchtower scan failed');
      emitBitvmSocket('bitvm-watchtower-error', { error: WATCHTOWER.lastError, at: Date.now() });
    });
  }, WATCHTOWER.intervalMs);
  return getBitvmWatchtowerStatus();
}

export function bitvmWatchtowerStop() {
  if (WATCHTOWER.timer) clearInterval(WATCHTOWER.timer);
  WATCHTOWER.timer = null;
  WATCHTOWER.running = false;
  emitBitvmSocket('bitvm-watchtower-update', { watchtower: getBitvmWatchtowerStatus(), at: Date.now() });
  return getBitvmWatchtowerStatus();
}

export async function bitvmWatchtowerTick(query?: WatchtowerQuery) {
  LOCAL_STATE.watchtowerLastTick = Date.now();
  const status = await fetchBitvmStatus(query);
  const out = { ...status, updatedAt: Date.now() };
  emitBitvmSocket('bitvm-watchtower-update', { status: out, watchtower: getBitvmWatchtowerStatus(), at: Date.now() });
  return out;
}

export async function bitvmEmitFraudProof(query?: WatchtowerQuery) {
  const status = await fetchBitvmStatus(query);
  const target = pickExpiringTarget(status, query);
  if (!target) {
    throw new Error('No expiring BitVM cache targets available for challenge emission.');
  }

  const oracleId = Number.isFinite(query?.oracleId) && Number(query?.oracleId) > 0
    ? Number(query?.oracleId)
    : Number(process.env.BITVM_ORACLE_ID || 1);
  const senderAddress = String(query?.senderAddress || '').trim() || await resolveOracleAdminAddress(oracleId);
  const challengerAddress = String(query?.challengerAddress || '').trim() || String(process.env.BITVM_CHALLENGER_ADDRESS || '').trim() || senderAddress;
  const challengeBondAmount = Number.isFinite(query?.challengeBondAmount)
    ? Number(query?.challengeBondAmount)
    : Number(process.env.BITVM_CHALLENGE_BOND_AMOUNT || 0);
  const challengeBondPropertyId = Number.isFinite(query?.challengeBondPropertyId) && Number(query?.challengeBondPropertyId) > 0
    ? Number(query?.challengeBondPropertyId)
    : Number(process.env.BITVM_CHALLENGE_BOND_PROPERTY_ID || target.propertyId || 1);
  const stateHash = `wallet-watchtower-${target.cacheId}-${Date.now()}`;
  const settlement = {
    mode: 'bitvm_challenge',
    cacheId: target.cacheId,
    challengerAddress,
    challengeBondAmount,
    challengeBondPropertyId,
  };
  const relayBlob = buildRelayBlob(settlement, stateHash);
  const payload = encodeStakeFraudProofPayload({
    action: 2,
    oracleId,
    stakedPropertyId: Number(target.propertyId || challengeBondPropertyId || 1),
    amount: 0,
    accusedAddress: '',
    evidenceHash: '',
    relayType: 1,
    stateHash,
    dlcRef: String(target.dlcRef || ''),
    settlementState: 'DISPUTED',
    relayBlob,
    autoRoll: false,
    nextDlcRef: '',
  });

  if (!fasitfyServer.rpcClient) {
    throw new Error('No wallet RPC client initialized for BitVM fraud-proof emission.');
  }

  const listUnspent = rpcRequireData(
    await fasitfyServer.rpcClient.call('listunspent', 0, 999999999, [senderAddress]),
    'listunspent',
  );
  const sorted = (Array.isArray(listUnspent) ? listUnspent : [])
    .filter((u: AnyObj) => Number(u?.amount || 0) > 0 && String(u?.txid || '').length > 0 && Number.isInteger(Number(u?.vout)))
    .sort((a: AnyObj, b: AnyObj) => Number(b.amount || 0) - Number(a.amount || 0));
  if (sorted.length === 0) {
    throw new Error(`No spendable UTXOs for sender ${senderAddress}.`);
  }
  const utxo = sorted[0];
  const fee = Number(process.env.BITVM_EMIT_FEE_LTC || 0.0003);
  const sendAmount = Number(utxo.amount || 0) - fee;
  if (!(sendAmount > 0)) {
    throw new Error(`Selected UTXO is too small after fee (${utxo.amount} LTC).`);
  }

  const baseRaw = rpcRequireData(
    await fasitfyServer.rpcClient.call(
      'createrawtransaction',
      [{ txid: String(utxo.txid), vout: Number(utxo.vout) }],
      { [senderAddress]: sendAmount }
    ),
    'createrawtransaction',
  );
  const payloadTxResp = await postListener('/tl_createrawtx_opreturn', { params: [baseRaw, payload] });
  const withPayloadRaw = rpcRequireData(payloadTxResp, 'tl_createrawtx_opreturn');
  const signed = rpcRequireData(
    await fasitfyServer.rpcClient.call('signrawtransactionwithwallet', withPayloadRaw),
    'signrawtransactionwithwallet',
  );
  if (!signed?.hex || signed?.complete !== true) {
    throw new Error('signrawtransactionwithwallet returned incomplete signature set.');
  }
  const txid = rpcRequireData(
    await fasitfyServer.rpcClient.call('sendrawtransaction', signed.hex),
    'sendrawtransaction',
  );

  LOCAL_STATE.fraudProofsSubmittedDelta += 1;
  const refreshed = await fetchBitvmStatus(query);
  const out = {
    ...refreshed,
    updatedAt: Date.now(),
    emission: {
      txid,
      senderAddress,
      oracleId,
      cacheId: target.cacheId,
      dlcRef: target.dlcRef,
      challengeDeadlineBlock: target.challengeDeadlineBlock,
    },
  };
  emitBitvmSocket('bitvm-fraud-proof-emitted', { data: out, at: Date.now() });
  emitBitvmSocket('bitvm-watchtower-update', { status: out, watchtower: getBitvmWatchtowerStatus(), at: Date.now() });
  return out;
}
