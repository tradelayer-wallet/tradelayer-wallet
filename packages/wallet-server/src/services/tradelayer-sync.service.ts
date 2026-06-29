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
  parsedHeight: number | null;
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
  if (Number.isFinite(parsed) && parsed > 0) {
    const scaled = parsed <= 1 ? parsed * 100 : parsed;
    return Math.max(0, Math.min(100, Number(scaled.toFixed(2))));
  }

  if (currentHeight !== null && targetHeight !== null && targetHeight > 0) {
    return Math.max(0, Math.min(100, Number(((currentHeight / targetHeight) * 100).toFixed(2))));
  }

  return 0;
}

async function fetchListenerParsedHeight(listenerUrl: string): Promise<number | null> {
  try {
    const { data } = await axios.post(`${listenerUrl}/tl_getMaxParsedHeight`, {}, { timeout: 5000 });
    return normalizeHeight(data?.maxParsedHeight ?? data?.parsedHeight ?? data);
  } catch (error: any) {
    if (Number(error?.response?.status) === 429) {
      return null;
    }
    return null;
  }
}

async function fetchListenerProcessedHeight(listenerUrl: string): Promise<number | null> {
  try {
    const { data } = await axios.post(`${listenerUrl}/tl_getMaxProcessedHeight`, {}, { timeout: 5000 });
    return normalizeHeight(data?.maxProcessedHeight ?? data?.processedHeight ?? data);
  } catch (error: any) {
    if (Number(error?.response?.status) === 429) {
      return null;
    }
    return null;
  }
}

async function fetchListenerTrackHeight(listenerUrl: string): Promise<number | null> {
  try {
    const { data } = await axios.post(`${listenerUrl}/tl_getTrackHeight`, {}, { timeout: 5000 });
    return normalizeHeight(data?.trackHeight ?? data?.maxProcessedHeight ?? data);
  } catch (error: any) {
    if (Number(error?.response?.status) === 429) {
      return null;
    }
    return null;
  }
}

function getWalletListenerUrl(): string {
  return trimSlash(process.env.TL_WALLET_LISTENER_URL || 'http://127.0.0.1:3000');
}

let listenerMainInitPromise: Promise<void> | null = null;
let lastKnownTradeLayerSyncStatus: TradeLayerSyncStatus | null = null;

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
  parsedHeight: number | null;
  processedHeight: number | null;
  trackHeight: number | null;
}): TradeLayerSyncStatus {
  const parsedHeight = normalizeHeight(raw?.parsedHeight) ?? listenerMeta.parsedHeight;
  const processedHeight = normalizeHeight(raw?.processedHeight) ?? listenerMeta.processedHeight;
  const trackHeight = normalizeHeight(raw?.trackHeight) ?? listenerMeta.trackHeight;
  const currentHeight = normalizeHeight(raw?.currentHeight) ?? listenerMeta.nodeBlock;
  const targetHeight = normalizeHeight(raw?.targetHeight)
    ?? normalizeHeight(raw?.chainTip)
    ?? listenerMeta.headerBlock
    ?? listenerMeta.nodeBlock;
  const rawPhase = String(raw?.phase || (listenerMeta.listenerReachable ? 'idle' : 'unavailable')).trim() || 'idle';
  const phase = (currentHeight !== null && rawPhase === 'waiting')
    ? 'realtime'
    : rawPhase;

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
    parsedHeight,
    processedHeight,
    trackHeight,
    currentHeight,
    targetHeight,
    percent: normalizePercent(listenerMeta.nodeBlock, listenerMeta.headerBlock ?? targetHeight, raw?.percent),
    updatedAt: Number.isFinite(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : null,
    nodeBlock: listenerMeta.nodeBlock,
    headerBlock: listenerMeta.headerBlock,
  };
}

async function finalizeTradeLayerSyncStatus(raw: AnyObj, listenerMeta: {
  listenerUrl: string;
  listenerReachable: boolean;
  listenerError: string | null;
  nodeBlock: number | null;
  headerBlock: number | null;
  parsedHeight: number | null;
  processedHeight: number | null;
  trackHeight: number | null;
}): Promise<TradeLayerSyncStatus> {
  const status = normalizeTradeLayerSyncStatus(raw, listenerMeta);
  lastKnownTradeLayerSyncStatus = status;
  try {
    await fasitfyServer?.collatorPeerService?.sync(status);
  } catch (error) {
    console.log('Unable to sync collator peers: ' + String((error as any)?.message || error));
  }
  return status;
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
  let parsedHeight: number | null = null;
  let processedHeight: number | null = null;
  let trackHeight: number | null = null;

  const collectListenerHeights = async () => {
    const nextParsedHeight = await fetchListenerParsedHeight(listenerUrl);
    const nextProcessedHeight = await fetchListenerProcessedHeight(listenerUrl);
    const nextTrackHeight = await fetchListenerTrackHeight(listenerUrl);

    parsedHeight = nextParsedHeight ?? parsedHeight ?? lastKnownTradeLayerSyncStatus?.parsedHeight ?? null;
    processedHeight = nextProcessedHeight ?? processedHeight ?? lastKnownTradeLayerSyncStatus?.processedHeight ?? null;
    trackHeight = nextTrackHeight ?? trackHeight ?? lastKnownTradeLayerSyncStatus?.trackHeight ?? null;
  };

  try {
    const { data } = await axios.post(`${listenerUrl}/tl_getSyncStatus`, {}, { timeout: 5000 });
    rawStatus = (data && typeof data === 'object') ? data : {};
    await collectListenerHeights();
  } catch (error: any) {
    if (Number(error?.response?.status) === 429) {
      listenerReachable = true;
      listenerError = null;
      rawStatus = {
        phase: 'paused',
        message: 'Litecoin node sync status is temporarily rate limited.',
        initialized: true,
      };
      if (lastKnownTradeLayerSyncStatus) {
        rawStatus = {
          ...rawStatus,
          processedHeight: lastKnownTradeLayerSyncStatus.processedHeight,
          trackHeight: lastKnownTradeLayerSyncStatus.trackHeight,
          parsedHeight: lastKnownTradeLayerSyncStatus.parsedHeight,
          currentHeight: lastKnownTradeLayerSyncStatus.currentHeight,
          targetHeight: lastKnownTradeLayerSyncStatus.targetHeight,
          chainTip: lastKnownTradeLayerSyncStatus.chainTip,
          indexedHeight: lastKnownTradeLayerSyncStatus.indexedHeight,
          genesisBlock: lastKnownTradeLayerSyncStatus.genesisBlock,
        };
      }
      await collectListenerHeights();
      return finalizeTradeLayerSyncStatus(rawStatus, {
        listenerUrl,
        listenerReachable,
        listenerError,
        nodeBlock,
        headerBlock,
        parsedHeight,
        processedHeight,
        trackHeight,
      });
    }
    listenerReachable = false;
    listenerError = error?.response?.data || error?.message || 'Unable to reach TradeLayer listener.';
    if (!nodeBlock) {
      rawStatus = {
        phase: 'starting',
        message: 'Waiting for Litecoin Core RPC before node sync status.',
        currentHeight: null,
        targetHeight: headerBlock,
      };
      if (lastKnownTradeLayerSyncStatus) {
        rawStatus = {
          ...rawStatus,
          processedHeight: lastKnownTradeLayerSyncStatus.processedHeight,
          trackHeight: lastKnownTradeLayerSyncStatus.trackHeight,
          parsedHeight: lastKnownTradeLayerSyncStatus.parsedHeight,
          currentHeight: lastKnownTradeLayerSyncStatus.currentHeight,
        };
      }
      return finalizeTradeLayerSyncStatus(rawStatus, {
        listenerUrl,
        listenerReachable,
        listenerError,
        nodeBlock,
        headerBlock,
        parsedHeight,
        processedHeight,
        trackHeight,
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
      await collectListenerHeights();
    } catch (retryError: any) {
      listenerError = retryError?.response?.data
        || retryError?.message
        || error?.response?.data
        || error?.message
        || 'Unable to reach TradeLayer listener.';
      rawStatus = {};
      if (lastKnownTradeLayerSyncStatus) {
        rawStatus = {
          ...rawStatus,
          phase: lastKnownTradeLayerSyncStatus.phase,
          message: lastKnownTradeLayerSyncStatus.message,
          initialized: lastKnownTradeLayerSyncStatus.initialized,
          genesisBlock: lastKnownTradeLayerSyncStatus.genesisBlock,
          chainTip: lastKnownTradeLayerSyncStatus.chainTip,
          indexedHeight: lastKnownTradeLayerSyncStatus.indexedHeight,
          parsedHeight: lastKnownTradeLayerSyncStatus.parsedHeight,
          processedHeight: lastKnownTradeLayerSyncStatus.processedHeight,
          trackHeight: lastKnownTradeLayerSyncStatus.trackHeight,
          currentHeight: lastKnownTradeLayerSyncStatus.currentHeight,
          targetHeight: lastKnownTradeLayerSyncStatus.targetHeight,
          percent: lastKnownTradeLayerSyncStatus.percent,
          updatedAt: lastKnownTradeLayerSyncStatus.updatedAt,
        };
      }
    }
  }

  if (listenerReachable && nodeBlock && !rawStatus?.initialized) {
    try {
      rawStatus = {
        ...rawStatus,
        phase: 'starting',
        message: 'Initializing Litecoin node sync.',
        targetHeight: headerBlock ?? nodeBlock,
        currentHeight: nodeBlock,
      };
      await ensureListenerMainInitialized(listenerUrl);
      const { data } = await axios.post(`${listenerUrl}/tl_getSyncStatus`, {}, { timeout: 5000 });
      rawStatus = (data && typeof data === 'object') ? data : rawStatus;
      await collectListenerHeights();
      listenerError = null;
    } catch (initError: any) {
      listenerError = initError?.response?.data
        || initError?.message
        || 'Unable to initialize TradeLayer parser.';
    }
  }

  return finalizeTradeLayerSyncStatus(rawStatus, {
    listenerUrl,
    listenerReachable,
    listenerError,
    nodeBlock,
    headerBlock,
    parsedHeight,
    processedHeight,
    trackHeight,
  });
}
