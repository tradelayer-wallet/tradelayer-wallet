import axios from 'axios';
import { fasitfyServer } from '../index';
import { createRpcClientFromDatadir } from './node.service';

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
};

function trimSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeHeight(value: any): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function normalizePercent(currentHeight: number | null, targetHeight: number | null, rawPercent: any): number {
  const parsed = Number(rawPercent);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.max(0, Math.min(100, Number(parsed.toFixed(2))));
  }

  if (currentHeight !== null && targetHeight !== null && targetHeight > 0) {
    return Math.max(0, Math.min(100, Number(((currentHeight / targetHeight) * 100).toFixed(2))));
  }

  return 0;
}

function getWalletListenerUrl(): string {
  return trimSlash(process.env.TL_WALLET_LISTENER_URL || 'http://127.0.0.1:3000');
}

let listenerMainInitPromise: Promise<void> | null = null;

async function ensureListenerMainInitialized(listenerUrl: string): Promise<void> {
  if (listenerMainInitPromise) {
    return listenerMainInitPromise;
  }

  listenerMainInitPromise = axios.post(`${listenerUrl}/tl_initmain`, { wallet: true }, { timeout: 60000 })
    .then((res) => {
      if (res?.data?.error) {
        throw new Error(res.data.error);
      }
    })
    .finally(() => {
      listenerMainInitPromise = null;
    });

  return listenerMainInitPromise;
}

function normalizeTradeLayerSyncStatus(raw: AnyObj, listenerMeta: {
  listenerUrl: string;
  listenerReachable: boolean;
  listenerError: string | null;
  nodeBlock: number | null;
  headerBlock: number | null;
}): TradeLayerSyncStatus {
  const phase = String(raw?.phase || (listenerMeta.listenerReachable ? 'idle' : 'unavailable')).trim() || 'idle';
  const processedHeight = normalizeHeight(raw?.processedHeight);
  const trackHeight = normalizeHeight(raw?.trackHeight);
  const currentHeight = normalizeHeight(raw?.currentHeight)
    ?? processedHeight
    ?? trackHeight;
  const targetHeight = normalizeHeight(raw?.targetHeight)
    ?? normalizeHeight(raw?.chainTip)
    ?? listenerMeta.headerBlock
    ?? listenerMeta.nodeBlock;

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
    processedHeight,
    trackHeight,
    currentHeight,
    targetHeight,
    percent: normalizePercent(currentHeight, targetHeight, raw?.percent),
    updatedAt: Number.isFinite(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : null,
    nodeBlock: listenerMeta.nodeBlock,
    headerBlock: listenerMeta.headerBlock,
  };
}

async function fetchNodeBlockState(): Promise<{ nodeBlock: number | null; headerBlock: number | null }> {
  if (!fasitfyServer.rpcClient) {
    const rpcClient = createRpcClientFromDatadir(process.env.DATADIR, Number(process.env.RPC_PORT));
    if (rpcClient) {
      try {
        const probe = await rpcClient.call('getblockchaininfo');
        if (probe?.data && !probe?.error) {
          fasitfyServer.rpcClient = rpcClient;
          fasitfyServer.rpcPort = Number(process.env.RPC_PORT) || 19332;
        }
      } catch {
        // The sync dialog will keep polling while Core warms up.
      }
    }
  }

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
    if (!nodeBlock) {
      rawStatus = {
        phase: 'starting',
        message: 'Waiting for Litecoin Core RPC before starting TradeLayer parser.',
        currentHeight: null,
        targetHeight: headerBlock,
      };
      return normalizeTradeLayerSyncStatus(rawStatus, {
        listenerUrl,
        listenerReachable,
        listenerError,
        nodeBlock,
        headerBlock,
      });
    }
    try {
      if (!fasitfyServer?.tradelayerService) {
        throw new Error('TradeLayer service is not available in the wallet backend.');
      }
      await fasitfyServer.tradelayerService.init();
      const { data } = await axios.post(`${listenerUrl}/tl_getSyncStatus`, {}, { timeout: 5000 });
      rawStatus = (data && typeof data === 'object') ? data : {};
      listenerReachable = true;
      listenerError = null;
    } catch (retryError: any) {
      listenerError = retryError?.response?.data
        || retryError?.message
        || error?.response?.data
        || error?.message
        || 'Unable to reach TradeLayer listener.';
      rawStatus = {};
    }
  }

  if (listenerReachable && nodeBlock && !rawStatus?.initialized) {
    try {
      rawStatus = {
        ...rawStatus,
        phase: 'starting',
        message: 'Initializing TradeLayer parser.',
        targetHeight: headerBlock ?? nodeBlock,
      };
      await ensureListenerMainInitialized(listenerUrl);
      const { data } = await axios.post(`${listenerUrl}/tl_getSyncStatus`, {}, { timeout: 5000 });
      rawStatus = (data && typeof data === 'object') ? data : rawStatus;
      listenerError = null;
    } catch (initError: any) {
      listenerError = initError?.response?.data
        || initError?.message
        || 'Unable to initialize TradeLayer parser.';
    }
  }

  return normalizeTradeLayerSyncStatus(rawStatus, {
    listenerUrl,
    listenerReachable,
    listenerError,
    nodeBlock,
    headerBlock,
  });
}
