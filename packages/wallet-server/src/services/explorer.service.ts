import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

type AnyRecord = Record<string, any>;

const TL_BASE_URL = process.env.TL_LISTENER_BASE_URL || 'http://localhost:3000/';
const BITVM_ARTIFACT_ROOT = process.env.BITVM_ARTIFACT_ROOT
  || 'C:\\projects\\UTXORef\\UTXO-Ref\\bitvm3\\utxo_referee\\artifacts';

function readJsonIfExists(filePath: string): AnyRecord | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeArray<T>(value: any): T[] {
  return Array.isArray(value) ? value : [];
}

function safeName(name: string) {
  return path.basename(String(name || '')).trim();
}

function sha256Hex(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function bufferFromHex(value: string) {
  return Buffer.from(String(value || ''), 'hex');
}

function readU64LE(buffer: Buffer, offset: number) {
  return buffer.readBigUInt64LE(offset).toString();
}

function readU16LE(buffer: Buffer, offset: number) {
  return buffer.readUInt16LE(offset);
}

function decodeWitnessItemHex(hex: string) {
  try {
    return bufferFromHex(hex).toString('utf8');
  } catch {
    return null;
  }
}

function tryParseJsonWitnessItem(hex: string) {
  const text = decodeWitnessItemHex(hex);
  if (!text) {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function countNonEmptyWitnessItems(witness: string[], start: number, endExclusive: number) {
  return witness.slice(start, endExclusive).filter((item) => String(item || '').length > 0).length;
}

function looksLikeBitvmVaultScript(scriptHex: string | null) {
  const hex = String(scriptHex || '').toLowerCase();
  if (!hex) return false;
  return hex.startsWith('63')
    && hex.includes('67')
    && hex.endsWith('68')
    && hex.includes('ad52')
    && hex.includes('b175');
}

function summarizeFundingOutputs(chainTx: AnyRecord | null) {
  const vout = safeArray<AnyRecord>(chainTx?.vout);
  return vout
    .filter((output) => String(output?.scriptPubKey?.type || '') === 'witness_v0_scripthash')
    .map((output) => ({
      n: output?.n,
      value: output?.value,
      scriptPubKeyHex: output?.scriptPubKey?.hex || null,
      addresses: safeArray<string>(output?.scriptPubKey?.addresses)
    }));
}

function decodeReceiptBalanceClaimCompact(hex: string) {
  const buffer = bufferFromHex(hex);
  if (buffer.length < 4 || buffer.subarray(0, 4).toString('ascii') !== 'rbc1') {
    return null;
  }

  let offset = 4;
  const epochId = readU64LE(buffer, offset); offset += 8;
  const challengeWindowStart = readU64LE(buffer, offset); offset += 8;
  const challengeWindowLength = readU64LE(buffer, offset); offset += 8;
  const challengeWindowEnd = readU64LE(buffer, offset); offset += 8;
  const balanceSats = readU64LE(buffer, offset); offset += 8;
  const index = readU16LE(buffer, offset); offset += 2;
  const accountIdLength = buffer.readUInt8(offset); offset += 1;
  const accountId = buffer.subarray(offset, offset + accountIdLength).toString('utf8'); offset += accountIdLength;
  const leafHash = buffer.subarray(offset, offset + 32).toString('hex'); offset += 32;
  const balanceRoot = buffer.subarray(offset, offset + 32).toString('hex'); offset += 32;
  const snapshotHash = buffer.subarray(offset, offset + 32).toString('hex'); offset += 32;
  const siblingCount = buffer.readUInt8(offset); offset += 1;
  const siblings: string[] = [];
  for (let i = 0; i < siblingCount; i++) {
    siblings.push(buffer.subarray(offset, offset + 32).toString('hex'));
    offset += 32;
  }

  return {
    kind: 'receipt-balance-claim-compact',
    preimageHex: hex,
    preimageHashHex: sha256Hex(buffer),
    byteLength: buffer.length,
    claim: {
      epochId,
      challengeWindowStart,
      challengeWindowLength,
      challengeWindowEnd,
      accountId,
      balanceSats,
      index,
      leafHash,
      balanceRoot,
      snapshotHash,
      siblings
    }
  };
}

function decodeBitvmWitness(chainTx: AnyRecord | null) {
  const fundingOutputs = summarizeFundingOutputs(chainTx);
  if (fundingOutputs.length) {
    return {
      kind: 'bitvm-funding-candidate',
      txid: chainTx?.txid || null,
      fundingOutputs
    };
  }

  const vin = safeArray<AnyRecord>(chainTx?.vin);
  for (const input of vin) {
    const witness = safeArray<string>(input?.txinwitness);
    if (!witness.length) continue;
    const witnessScriptHex = witness.length >= 1 ? witness[witness.length - 1] : null;
    const branchSelectorHex = witness.length >= 2 ? witness[witness.length - 2] : null;
    const compactClaim = witness.find((item) => String(item || '').startsWith(Buffer.from('rbc1', 'ascii').toString('hex')));
    if (compactClaim) {
      return {
        kind: 'oracle-claim-spend',
        txid: chainTx?.txid || null,
        inputTxid: input?.txid || null,
        inputVout: input?.vout ?? null,
        witnessItems: witness.length,
        branchSelectorHex,
        witnessScriptHex,
        compactClaim: decodeReceiptBalanceClaimCompact(compactClaim)
      };
    }

    if (looksLikeBitvmVaultScript(witnessScriptHex)) {
      const branchSelectorText = decodeWitnessItemHex(branchSelectorHex || '');
      const signatureCount = countNonEmptyWitnessItems(witness, 0, Math.max(0, witness.length - 2));
      const settlementPayload = safeArray<string>(witness)
        .map((item) => tryParseJsonWitnessItem(item))
        .find((parsed) => parsed && typeof parsed === 'object' && (parsed.settlementBreakdown || parsed.kind === 'm1_expiry_redemption'));
      const settlementBreakdown = settlementPayload?.settlementBreakdown
        || settlementPayload?.deltas?.settlementBreakdown
        || null;
      return {
        kind: branchSelectorHex ? 'bitvm-vault-claim-branch-spend' : 'bitvm-vault-timeout-spend',
        txid: chainTx?.txid || null,
        inputTxid: input?.txid || null,
        inputVout: input?.vout ?? null,
        witnessItems: witness.length,
        signatureCount,
        branchSelectorHex,
        branchSelectorText,
        witnessScriptHex,
        scriptTemplate: 'if-oracle-claim-else-timeout-2of2',
        settlementPayload,
        settlementBreakdown
      };
    }
  }
  return null;
}

export class ExplorerService {
  async getOverview(rpcClient?: any) {
    const [sync, maxProcessed, maxParsed, properties, report, draft, funding, finalized, rollForward, challengeBundle, challengeWitness, expiryRedemption] = await Promise.all([
      axios.post(TL_BASE_URL + 'tl_checkSync', {}).then((res) => res.data).catch((error) => ({ error: String(error?.message || error) })),
      axios.post(TL_BASE_URL + 'tl_getMaxProcessedHeight', {}).then((res) => res.data).catch((error) => ({ error: String(error?.message || error) })),
      axios.post(TL_BASE_URL + 'tl_getMaxParsedHeight', {}).then((res) => res.data).catch((error) => ({ error: String(error?.message || error) })),
      axios.post(TL_BASE_URL + 'tl_listProperties', {}).then((res) => safeArray(res.data)).catch(() => []),
      this.getBitvmReport(),
      this.readArtifact('m1_dlc_draft_latest.json'),
      this.readArtifact('m1_funding_psbt_latest.json'),
      this.readArtifact('m1_funding_finalized_latest.json'),
      this.readArtifact('m1_roll_forward_latest.json'),
      this.readArtifact('m1_challenge_bundle_latest.json'),
      this.readArtifact('m1_challenge_witness_latest.json'),
      this.readArtifact('m1_expiry_redemption_latest.json')
    ]);

    const chainInfo = rpcClient?.call
      ? await rpcClient.call('getblockchaininfo').then((res: any) => res?.data || res).catch(() => null)
      : null;

    return {
      chainInfo,
      sync,
      maxProcessed,
      maxParsed,
      properties,
      bitvm: report,
      artifacts: {
        index: await this.listArtifacts(),
        draft,
        funding,
        finalized,
        rollForward,
        challengeBundle,
        challengeWitness,
        expiryRedemption
      }
    };
  }

  async getAddressSnapshot(address: string) {
    if (!address) {
      throw new Error('address is required');
    }

    const [balances, channel, attestations] = await Promise.all([
      axios.post(TL_BASE_URL + 'tl_getAllBalancesForAddress', { params: address }).then((res) => res.data).catch((error) => ({ error: String(error?.message || error) })),
      axios.post(TL_BASE_URL + 'tl_getChannel', { params: address }).then((res) => res.data).catch(() => null),
      axios.post(TL_BASE_URL + 'tl_getAttestations', { address, id: 0 }).then((res) => res.data).catch(() => [])
    ]);

    return {
      address,
      balances,
      channel,
      attestations
    };
  }

  async getAddressHistory(address: string) {
    if (!address) {
      throw new Error('address is required');
    }

    const [balances, channel, attestations, totalTradeHistory] = await Promise.all([
      axios.post(TL_BASE_URL + 'tl_getAllBalancesForAddress', { params: address }).then((res) => res.data).catch((error) => ({ error: String(error?.message || error) })),
      axios.post(TL_BASE_URL + 'tl_getChannel', { params: address }).then((res) => res.data).catch(() => null),
      axios.post(TL_BASE_URL + 'tl_getAttestations', { address, id: 0 }).then((res) => res.data).catch(() => []),
      axios.get(TL_BASE_URL + 'tl_totalTradeHistoryForAddress', { params: { address } }).then((res) => res.data).catch(() => [])
    ]);

    return {
      address,
      balances,
      channel,
      attestations,
      totalTradeHistory
    };
  }

  async getPropertySnapshot(propertyId: number) {
    if (!Number.isFinite(propertyId)) {
      throw new Error('propertyId is required');
    }
    const [property, balances] = await Promise.all([
      axios.post(TL_BASE_URL + 'tl_getProperty', { params: propertyId }).then((res) => res.data).catch((error) => ({ error: String(error?.message || error) })),
      axios.post(TL_BASE_URL + 'tl_listProperties', {}).then((res) => safeArray(res.data)).catch(() => [])
    ]);
    return {
      propertyId,
      property,
      knownProperties: balances
    };
  }

  async getContractHistory(contractId: number) {
    if (!Number.isFinite(contractId)) {
      throw new Error('contractId is required');
    }

    const [contractInfo, contractTradeHistory, fundingHistory, oracleHistory] = await Promise.all([
      axios.get(TL_BASE_URL + 'tl_getContractInfo', { params: { contractId } }).then((res) => res.data).catch((error) => ({ error: String(error?.message || error) })),
      axios.get(TL_BASE_URL + 'tl_contractTradeHistory', { params: { contractId } }).then((res) => res.data).catch(() => []),
      axios.get(TL_BASE_URL + 'tl_fundingHistory', { params: { contractId } }).then((res) => res.data).catch(() => []),
      axios.get(TL_BASE_URL + 'tl_oracleHistory', { params: { contractId } }).then((res) => res.data).catch(() => [])
    ]);

    return {
      contractId,
      contractInfo,
      contractTradeHistory,
      fundingHistory,
      oracleHistory
    };
  }

  async getTxSnapshot(txid: string, rpcClient?: any) {
    if (!txid) {
      throw new Error('txid is required');
    }
    const [tlTx, chainTx] = await Promise.all([
      axios.post(TL_BASE_URL + 'tl_getTransaction', { txid }).then((res) => res.data).catch((error) => ({ error: String(error?.message || error) })),
      rpcClient?.call
        ? rpcClient.call('getrawtransaction', txid, true).then((res: any) => res?.data || res).catch((error: any) => ({ error: String(error?.message || error) }))
        : Promise.resolve(null)
    ]);
    return { txid, tlTx, chainTx, bitvmDecode: decodeBitvmWitness(chainTx) };
  }

  async decodeBitvmTx(txid: string, rpcClient?: any) {
    if (!txid) {
      throw new Error('txid is required');
    }
    const chainTx = rpcClient?.call
      ? await rpcClient.call('getrawtransaction', txid, true).then((res: any) => res?.data || res)
      : null;
    return {
      txid,
      chainTx,
      bitvmDecode: decodeBitvmWitness(chainTx)
    };
  }

  async listArtifacts() {
    try {
      if (!fs.existsSync(BITVM_ARTIFACT_ROOT)) return [];
      return fs.readdirSync(BITVM_ARTIFACT_ROOT)
        .map((name) => {
          const filePath = path.join(BITVM_ARTIFACT_ROOT, name);
          const stat = fs.statSync(filePath);
          return {
            name,
            path: filePath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ext: path.extname(name).toLowerCase()
          };
        })
        .filter((entry) => ['.json', '.md'].includes(entry.ext))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    } catch {
      return [];
    }
  }

  async getBitvmReport() {
    const report = this.readArtifact('m1_visualization_latest.json');
    return report || {
      error: 'BitVM visualization artifact not found',
      expectedPath: path.join(BITVM_ARTIFACT_ROOT, 'm1_visualization_latest.json')
    };
  }

  readArtifact(name: string) {
    const filePath = path.join(BITVM_ARTIFACT_ROOT, safeName(name));
    return readJsonIfExists(filePath);
  }

  async getArtifact(name: string) {
    const fileName = safeName(name);
    const filePath = path.join(BITVM_ARTIFACT_ROOT, fileName);
    if (!fs.existsSync(filePath)) {
      return {
        error: 'artifact not found',
        name: fileName,
        expectedPath: filePath
      };
    }

    const stat = fs.statSync(filePath);
    const body = fs.readFileSync(filePath, 'utf8');
    return {
      name: fileName,
      path: filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ext: path.extname(fileName).toLowerCase(),
      content: fileName.endsWith('.json') ? JSON.parse(body) : body
    };
  }
}

export const explorerService = new ExplorerService();
