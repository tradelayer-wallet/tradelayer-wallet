import axios from 'axios';
import fs from 'fs';
import path from 'path';

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

export class ExplorerService {
  async getOverview(rpcClient?: any) {
    const [sync, maxProcessed, maxParsed, properties, report, draft, funding, finalized, rollForward] = await Promise.all([
      axios.post(TL_BASE_URL + 'tl_checkSync', {}).then((res) => res.data).catch((error) => ({ error: String(error?.message || error) })),
      axios.post(TL_BASE_URL + 'tl_getMaxProcessedHeight', {}).then((res) => res.data).catch((error) => ({ error: String(error?.message || error) })),
      axios.post(TL_BASE_URL + 'tl_getMaxParsedHeight', {}).then((res) => res.data).catch((error) => ({ error: String(error?.message || error) })),
      axios.post(TL_BASE_URL + 'tl_listProperties', {}).then((res) => safeArray(res.data)).catch(() => []),
      this.getBitvmReport(),
      this.readArtifact('m1_dlc_draft_latest.json'),
      this.readArtifact('m1_funding_psbt_latest.json'),
      this.readArtifact('m1_funding_finalized_latest.json'),
      this.readArtifact('m1_roll_forward_latest.json')
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
        rollForward
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
    return { txid, tlTx, chainTx };
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
