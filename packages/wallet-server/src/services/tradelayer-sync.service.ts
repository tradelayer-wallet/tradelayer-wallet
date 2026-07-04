import axios from 'axios';
import { fasitfyServer } from '../index';

type AnyObj = Record<string, any>;

export type TradeLayerSyncStatus = {
  listenerUrl: string;
  listenerReachable: boolean;
  listenerError: string | null;
  initialized: boolean;
  phase: string;
  message: string;
  genesisBlock: number | null;
  chainTip: number | null;
  indexedHeight: number | null;
  processedHeight: number | null;
  trackHeight: number | null;
  currentHeight: number | null;
  targetHeight: number | null;
  percent: number;
  updatedAt: number | null;
  nodeBlock: number | null;
  headerBlock: number | null;
  parsedCurrentHeight: number | null;
  parsedTargetHeight: number | null;
  parsedPercent: number;
};

function trimSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeHeight(value: any): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function normalizePercent(currentHeight: number | null, targetHeight: number | null, rawPercent: any): number {
  if (currentHeight !== null && targetHeight !== null && targetHeight > 0) {
    return Math.max(0, Math.min(100, Number(((currentHeight / targetHeight) * 100).toFixed(2))));
  }

  const parsed = Number(rawPercent);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.max(0, Math.min(100, Number(parsed.toFixed(2))));
  }

  return 0;
}

function getWalletListenerUrl(): string {
  return trimSlash(process.env.TL_WALLET_LISTENER_URL || 'http://127.0.0.1:3000');
}

function normalizeTradeLayerSyncStatus(raw: AnyObj, listenerMeta: {
  listenerUrl: string;
  listenerReachable: boolean;
  listenerError: string | null;
  nodeBlock: number | null;
  headerBlock: number | null;
}): TradeLayerSyncStatus {
  const phase = String(raw?.phase || (listenerMeta.listenerReachable ? 'idle' : 'unavailable')).trim() || 'idle';
  const parsedCurrentHeight = normalizeHeight(raw?.currentHeight);
  const parsedTargetHeight = normalizeHeight(raw?.targetHeight)
    ?? normalizeHeight(raw?.chainTip)
    ?? listenerMeta.nodeBlock;
  const currentHeight = listenerMeta.nodeBlock;
  const targetHeight = listenerMeta.headerBlock;

  return {
    listenerUrl: listenerMeta.listenerUrl,
    listenerReachable: listenerMeta.listenerReachable,
    listenerError: listenerMeta.listenerError,
    initialized: !!raw?.initialized,
    phase,
    message: String(raw?.message || (listenerMeta.listenerReachable ? '' : 'TradeLayer listener is unavailable.')).trim(),
    genesisBlock: normalizeHeight(raw?.genesisBlock),
    chainTip: normalizeHeight(raw?.chainTip) ?? listenerMeta.nodeBlock,
    indexedHeight: normalizeHeight(raw?.indexedHeight),
    processedHeight: normalizeHeight(raw?.processedHeight),
    trackHeight: normalizeHeight(raw?.trackHeight),
    currentHeight,
    targetHeight,
    percent: normalizePercent(currentHeight, targetHeight, raw?.percent),
    updatedAt: Number.isFinite(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : null,
    nodeBlock: listenerMeta.nodeBlock,
    headerBlock: listenerMeta.headerBlock,
    parsedCurrentHeight,
    parsedTargetHeight,
    parsedPercent: normalizePercent(parsedCurrentHeight, parsedTargetHeight, raw?.percent),
  };
}

async function fetchNodeBlockState(): Promise<{ nodeBlock: number | null; headerBlock: number | null }> {
  if (!fasitfyServer.rpcClient) {
    return { nodeBlock: null, headerBlock: null };
  }

  try {
    const infoRes = await fasitfyServer.rpcClient.call('getblockchaininfo');
    return {
      nodeBlock: normalizeHeight(infoRes?.data?.blocks),
      headerBlock: normalizeHeight(infoRes?.data?.headers),
    };
  } catch {
    return { nodeBlock: null, headerBlock: null };
  }
}

export async function getTradeLayerSyncStatus(): Promise<TradeLayerSyncStatus> {
  const listenerUrl = getWalletListenerUrl();
  const { nodeBlock, headerBlock } = await fetchNodeBlockState();

  let rawStatus: AnyObj = {};
  let listenerReachable = true;
  let listenerError: string | null = null;

  try {
    const { data } = await axios.post(`${listenerUrl}/tl_getSyncStatus`, {}, { timeout: 5000 });
    rawStatus = (data && typeof data === 'object') ? data : {};
  } catch (error: any) {
    listenerReachable = false;
    listenerError = error?.response?.data || error?.message || 'Unable to reach TradeLayer listener.';
    rawStatus = {};
  }

  return normalizeTradeLayerSyncStatus(rawStatus, {
    listenerUrl,
    listenerReachable,
    listenerError,
    nodeBlock,
    headerBlock,
  });
}
