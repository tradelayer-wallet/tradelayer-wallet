import { ChildProcess, spawn } from 'child_process';
import axios from 'axios';
import { existsSync } from 'fs';
import { hostname } from 'os';
import { dirname, join, resolve } from 'path';
import { URL } from 'url';

import type { TradeLayerSyncStatus } from './tradelayer-sync.service';

type PeerProc = {
  url: string;
  child: ChildProcess;
  startedAt: number;
  lastRegistryCheckAt: number;
};

type PeerHealth = {
  url: string;
  state: 'starting' | 'awaiting-registry' | 'advertised' | 'missing' | 'registry-unreachable' | 'stopped' | 'exited' | 'start-failed';
  startedAt: number | null;
  lastRegistryCheckAt: number | null;
  lastRegistryConfirmedAt: number | null;
  lastRegistryError: string | null;
  lastExitAt: number | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  recoveryScheduledAt: number | null;
  restartCount: number;
};

const DEFAULT_COLLATORS = [
  'ws://127.0.0.1:8787/ws',
  'ws://127.0.0.1:8788/ws',
];
const PEER_RETRY_COOLDOWN_MS = 15_000;
const PEER_REGISTRY_GRACE_MS = 5_000;
const PEER_REGISTRY_CHECK_INTERVAL_MS = 5_000;
const PEER_ADVERTISE_INTERVAL_MS = 5_000;
const PEER_HEALTH_MONITOR_INTERVAL_MS = 5_000;
const PEER_CLEAN_EXIT_RECOVERY_DELAY_MS = 2_000;

// These methods are intentionally limited to listener-backed reads and unsigned payload construction.
// Wallet administration, signing, key material, PSBT finalization, and broadcasting remain local-only.
export const ADVERTISED_PROVIDER_METHODS = [
  { method: 'tl_getStateSnapshot', listenerRoute: '/tl_getStateSnapshot', httpMethod: 'POST' },
  { method: 'tl_watchonly_register', listenerRoute: '/tl_watchonly_register', httpMethod: 'POST' },
  { method: 'tl_watchonly_utxos', listenerRoute: '/tl_watchonly_utxos', httpMethod: 'POST' },
  { method: 'tl_getSyncStatus', listenerRoute: '/tl_getSyncStatus', httpMethod: 'POST' },
  { method: 'tl_getAllBalancesForAddress', listenerRoute: '/tl_getAllBalancesForAddress', httpMethod: 'POST' },
  { method: 'tl_getChannel', listenerRoute: '/tl_getChannel', httpMethod: 'POST' },
  { method: 'tl_getChannelColumn', listenerRoute: '/tl_getChannelColumn', httpMethod: 'POST' },
  { method: 'tl_getContractInfo', listenerRoute: '/tl_getContractInfo', httpMethod: 'GET' },
  { method: 'tl_getAttestations', listenerRoute: '/tl_getAttestations', httpMethod: 'POST' },
  { method: 'tl_getTransaction', listenerRoute: '/tl_getTransaction', httpMethod: 'POST' },
  { method: 'tl_getClearlistById', listenerRoute: '/tl_getClearlistById', httpMethod: 'POST' },
  { method: 'tl_listContractSeries', listenerRoute: '/tl_listContractSeries', httpMethod: 'POST' },
  { method: 'tl_getInitMargin', listenerRoute: '/tl_getInitMargin', httpMethod: 'GET' },
  { method: 'tl_channelBalanceForCommiter', listenerRoute: '/tl_channelBalanceForCommiter', httpMethod: 'GET' },
  { method: 'tl_getMaxSynth', listenerRoute: '/tl_getMaxSynth', httpMethod: 'GET' },
  { method: 'tl_contractPosition', listenerRoute: '/tl_contractPosition', httpMethod: 'GET' },
  { method: 'tl_tokenTradeHistoryForAddress', listenerRoute: '/tl_tokenTradeHistoryForAddress', httpMethod: 'GET' },
  { method: 'tl_contractTradeHistoryForAddress', listenerRoute: '/tl_contractTradeHistoryForAddress', httpMethod: 'GET' },
  { method: 'tl_totalTradeHistoryForAddress', listenerRoute: '/tl_totalTradeHistoryForAddress', httpMethod: 'GET' },
  { method: 'tl_getInfo', listenerRoute: '/tl_getSyncStatus', httpMethod: 'POST' },
  { method: 'tl_getBalance', listenerRoute: '/tl_getAllBalancesForAddress', httpMethod: 'POST' },
  { method: 'tl_getProperty', listenerRoute: '/tl_getProperty', httpMethod: 'POST' },
  { method: 'tl_listProperties', listenerRoute: '/tl_listProperties', httpMethod: 'POST' },
  { method: 'tl_createpayload_attestation', listenerRoute: '/tl_createpayload_attestation', httpMethod: 'POST' },
  { method: 'tl_createpayload_commit_tochannel', listenerRoute: '/tl_createpayload_commit_tochannel', httpMethod: 'POST' },
] as const;

function trimSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

function splitUrls(value: string): string[] {
  return String(value || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function collatorHttpBase(wsUrl: string): string {
  const raw = String(wsUrl || '').trim();
  try {
    const url = new URL(raw);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = url.pathname.replace(/\/ws\/?$/, '') || '/';
    url.search = '';
    url.hash = '';
    return trimSlash(url.toString());
  } catch {
    return trimSlash(raw.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/ws\/?$/, ''));
  }
}

function currentChain(): 'BTC' | 'LTC' | '' {
  const raw = String(process.env.CHAIN || process.env.DEFAULT_CHAIN || '').trim().toUpperCase();
  if (raw.startsWith('LTC')) return 'LTC';
  if (raw.startsWith('BTC')) return 'BTC';
  return '';
}

function currentNetwork(): string {
  const explicit = String(process.env.NETWORK || '').trim().toLowerCase();
  if (explicit) return explicit;
  const label = String(process.env.DEFAULT_CHAIN || '').trim().toUpperCase();
  if (label.includes('TEST')) return 'testnet';
  if (label.includes('LIVE') || label.includes('MAIN')) return 'mainnet';
  return '';
}

function defaultCollatorUrls(): string[] {
  const chain = currentChain();
  const network = currentNetwork();

  if (chain === 'LTC') {
    return network === 'mainnet'
      ? ['wss://api.layerwallet.com/ws']
      : ['wss://testnet-api.layerwallet.com/ws'];
  }

  if (chain === 'BTC') {
    return network === 'mainnet'
      ? ['wss://btc-api.layerwallet.com/ws']
      : ['wss://testnet-api.layerwallet.com/ws'];
  }

  return ['wss://testnet-api.layerwallet.com/ws'];
}

export class CollatorPeerService {
  private peers = new Map<string, PeerProc>();
  private peerHealth = new Map<string, PeerHealth>();
  private lastPeerFailureAt = new Map<string, number>();
  private syncInProgress = false;
  private syncQueue: TradeLayerSyncStatus | null = null;
  private lastShouldContributeReason = 'not evaluated';
  private lastSyncAt: number | null = null;
  private desiredPeerUrls = new Set<string>();
  private lastSyncStatus: TradeLayerSyncStatus | null = null;
  private healthMonitorTimer: NodeJS.Timeout | null = null;
  private recoveryTimers = new Map<string, NodeJS.Timeout>();

  private healthFor(url: string): PeerHealth {
    const existing = this.peerHealth.get(url);
    if (existing) return existing;

    const health: PeerHealth = {
      url,
      state: 'stopped',
      startedAt: null,
      lastRegistryCheckAt: null,
      lastRegistryConfirmedAt: null,
      lastRegistryError: null,
      lastExitAt: null,
      lastExitCode: null,
      lastExitSignal: null,
      recoveryScheduledAt: null,
      restartCount: 0,
    };
    this.peerHealth.set(url, health);
    return health;
  }

  private clearRecoveryTimer(url: string) {
    const timer = this.recoveryTimers.get(url);
    if (timer) clearTimeout(timer);
    this.recoveryTimers.delete(url);
    this.healthFor(url).recoveryScheduledAt = null;
  }

  private scheduleCleanExitRecovery(url: string) {
    if (!this.desiredPeerUrls.has(url) || this.recoveryTimers.has(url)) return;

    const health = this.healthFor(url);
    health.recoveryScheduledAt = Date.now() + PEER_CLEAN_EXIT_RECOVERY_DELAY_MS;
    const timer = setTimeout(async () => {
      this.recoveryTimers.delete(url);
      health.recoveryScheduledAt = null;
      if (!this.desiredPeerUrls.has(url)) return;

      try {
        this.startPeer(url);
        await this.restartPeerIfMissingFromRegistry(url);
      } catch (error: any) {
        console.log(`[tl-collator peer ${url}] clean-exit recovery failed: ${error?.message || error}`);
      }
    }, PEER_CLEAN_EXIT_RECOVERY_DELAY_MS);
    this.recoveryTimers.set(url, timer);
  }

  private updateHealthMonitor() {
    if (!this.desiredPeerUrls.size || !this.lastSyncStatus) {
      if (this.healthMonitorTimer) clearInterval(this.healthMonitorTimer);
      this.healthMonitorTimer = null;
      return;
    }
    if (this.healthMonitorTimer) return;

    this.healthMonitorTimer = setInterval(() => {
      if (this.lastSyncStatus) void this.sync(this.lastSyncStatus);
    }, PEER_HEALTH_MONITOR_INTERVAL_MS);
  }

  private get autoContributeEnabled(): boolean {
    const raw = String(process.env.TL_COLLATOR_AUTO_CONTRIBUTE || '1').trim().toLowerCase();
    return raw !== '0' && raw !== 'false' && raw !== 'off';
  }

  private get listenerUrl(): string {
    return trimSlash(process.env.TL_WALLET_LISTENER_URL || 'http://127.0.0.1:3000');
  }

  private get walletRpcUrl(): string {
    const host = String(process.env.WALLET_API_HOST || '127.0.0.1').trim() || '127.0.0.1';
    const port = String(process.env.WALLET_API_PORT || process.env.TL_WALLET_API_PORT || '1986').trim() || '1986';
    return trimSlash(process.env.TL_WALLET_RPC_TARGET || `http://${host}:${port}`);
  }

  private get rpcNetwork(): string {
    const chain = currentChain();
    const network = currentNetwork();

    if (chain === 'LTC') {
      return network === 'mainnet' ? 'litecoin.mainnet' : `litecoin.${network || 'testnet'}`;
    }

    if (chain === 'BTC') {
      return network === 'mainnet' ? 'bitcoin.mainnet' : (network === 'testnet' ? 'bitcoin.testnet4' : `bitcoin.${network || 'testnet4'}`);
    }

    return String(process.env.TL_COLLATOR_RPC_NETWORK || 'bitcoin.testnet4').trim();
  }

  private get rpcService(): string {
    return String(process.env.TL_COLLATOR_RPC_SERVICE || 'tradelayer.rpc').trim();
  }

  private get rpcNodeId(): string {
    return String(process.env.TL_COLLATOR_RPC_NODE_ID || `desktop-wallet-${hostname()}-${process.pid}`).trim();
  }

  private get collatorUrls(): string[] {
    const urls = splitUrls(
      process.env.TL_COLLATOR_WS_URLS
      || process.env.TL_COLLATOR_WS_URL
      || process.env.TL_COLLATOR_WS
      || ''
    );
    return urls.length ? urls : defaultCollatorUrls();
  }

  private getNodeCommandEnv() {
    if (process.env.TL_NODE_BINARY) {
      return {
        command: process.env.TL_NODE_BINARY,
        env: { ...process.env },
      };
    }

    return {
      command: 'node',
      env: { ...process.env },
    };
  }

  private resolvePeerScript() {
    const configuredPath = String(process.env.TL_COLLATOR_RPC_PEER_PATH || '').trim();
    const candidates = [
      configuredPath,
      join(process.cwd(), 'tl-collator', 'scripts', 'fullnode-rpc-peer.cjs'),
      join(process.cwd(), '..', 'tl-collator', 'scripts', 'fullnode-rpc-peer.cjs'),
      'C:\\projects\\tl-collator\\scripts\\fullnode-rpc-peer.cjs',
    ].filter(Boolean);

    const scriptPath = candidates
      .map((candidate) => resolve(candidate))
      .find((candidate) => existsSync(candidate));

    if (!scriptPath) {
      throw new Error(`tl-collator peer script not found. Checked: ${candidates.join(', ')}`);
    }

    return scriptPath;
  }

  private isPeerHealthy(child: ChildProcess): boolean {
    const proc = child as any;
    return !proc.killed && proc.exitCode === null && proc.signalCode === null;
  }

  private stopPeer(url: string) {
    const peer = this.peers.get(url);
    if (!peer) return;

    try {
      if (this.isPeerHealthy(peer.child)) {
        peer.child.kill();
      }
    } catch (_) {}

    this.peers.delete(url);
    this.healthFor(url).state = 'stopped';
  }

  private startPeer(url: string) {
    const lastFailedAt = this.lastPeerFailureAt.get(url) || 0;
    if (lastFailedAt && Date.now() - lastFailedAt < PEER_RETRY_COOLDOWN_MS) {
      this.healthFor(url).state = 'start-failed';
      console.log(`[tl-collator peer ${url}] retry cooldown active; skipping restart`);
      return;
    }

    if (this.peers.has(url)) {
      const existing = this.peers.get(url);
      if (existing && this.isPeerHealthy(existing.child)) {
        return;
      }
      this.peers.delete(url);
    }

    const scriptPath = this.resolvePeerScript();
    const { command, env } = this.getNodeCommandEnv();
    const startedAt = Date.now();
    const child = spawn(command, [scriptPath], {
      cwd: dirname(dirname(scriptPath)),
      env: {
        ...env,
        COLLATOR_WS: url,
        RPC_TARGET: this.listenerUrl,
        RPC_WALLET_TARGET: this.walletRpcUrl,
        RPC_SERVICE: this.rpcService,
        RPC_NETWORK: this.rpcNetwork,
        RPC_NODE_ID: this.rpcNodeId,
        RPC_METHODS_JSON: JSON.stringify(ADVERTISED_PROVIDER_METHODS.map(({ method }) => method)),
        RPC_ADVERTISE_INTERVAL_MS: String(PEER_ADVERTISE_INTERVAL_MS),
      },
      windowsHide: true,
    });

    this.peers.set(url, { url, child, startedAt, lastRegistryCheckAt: 0 });
    const health = this.healthFor(url);
    health.state = 'starting';
    health.startedAt = startedAt;
    health.lastRegistryError = null;

    child.stdout.on('data', (data) => {
      const text = String(data || '').trim();
      if (text) console.log(`[tl-collator peer ${url}] ${text}`);
    });

    child.stderr.on('data', (data) => {
      const text = String(data || '').trim();
      if (text) console.log(`[tl-collator peer ${url}][stderr] ${text}`);
    });

    child.once('exit', (code, signal) => {
      const isCurrentPeer = this.peers.get(url)?.child === child;
      if (isCurrentPeer) {
        this.peers.delete(url);
        const health = this.healthFor(url);
        health.state = 'exited';
        health.lastExitAt = Date.now();
        health.lastExitCode = code;
        health.lastExitSignal = signal;
      }
      if (isCurrentPeer && (code !== 0 || signal)) {
        this.lastPeerFailureAt.set(url, Date.now());
      }
      if (isCurrentPeer && code === 0 && !signal) {
        this.scheduleCleanExitRecovery(url);
      }
      console.log(`[tl-collator peer ${url}] exited code=${code} signal=${signal}`);
    });

    child.once('error', (error) => {
      const isCurrentPeer = this.peers.get(url)?.child === child;
      if (isCurrentPeer) this.peers.delete(url);
      if (isCurrentPeer) {
        this.lastPeerFailureAt.set(url, Date.now());
        const health = this.healthFor(url);
        health.state = 'start-failed';
        health.lastRegistryError = error?.message || String(error);
      }
      console.log(`[tl-collator peer ${url}] failed to start: ${error?.message || error}`);
    });
  }

  private shouldContribute(status: TradeLayerSyncStatus): boolean {
    if (!this.autoContributeEnabled) {
      this.lastShouldContributeReason = 'auto-contribute disabled';
      return false;
    }
    if (!status?.listenerReachable) {
      this.lastShouldContributeReason = 'listener unreachable';
      return false;
    }

    const liveHeight = Number(
      status.nodeBlock
      ?? status.currentHeight
      ?? -1,
    );
    const targetHeight = Number(
      status.headerBlock
      ?? status.targetHeight
      ?? status.chainTip
      ?? -1,
    );

    if (!Number.isFinite(liveHeight) || liveHeight < 0) {
      this.lastShouldContributeReason = 'missing live height';
      return false;
    }
    if (!Number.isFinite(targetHeight) || targetHeight < 0) {
      this.lastShouldContributeReason = 'missing target height';
      return false;
    }

    const phase = String(status?.phase || '').trim().toLowerCase();
    const ready = phase === 'realtime' || liveHeight + 1 >= targetHeight;
    if (!status?.initialized && !ready) {
      this.lastShouldContributeReason = 'listener not initialized';
      return false;
    }
    this.lastShouldContributeReason = ready
      ? `ready (${phase || 'unknown'} ${liveHeight}/${targetHeight})`
      : `not yet at tip (${phase || 'unknown'} ${liveHeight}/${targetHeight})`;
    return ready;
  }

  private async isAdvertisedInRegistry(url: string): Promise<boolean | null> {
    const peer = this.peers.get(url);
    const health = this.healthFor(url);
    if (!peer || !this.isPeerHealthy(peer.child)) {
      health.state = 'missing';
      return false;
    }

    const ageMs = Date.now() - peer.startedAt;
    if (ageMs < PEER_REGISTRY_GRACE_MS) {
      health.state = 'awaiting-registry';
      return true;
    }

    const sinceLastCheckMs = Date.now() - peer.lastRegistryCheckAt;
    if (peer.lastRegistryCheckAt && sinceLastCheckMs < PEER_REGISTRY_CHECK_INTERVAL_MS) return true;
    peer.lastRegistryCheckAt = Date.now();
    health.lastRegistryCheckAt = peer.lastRegistryCheckAt;

    const providersUrl = `${collatorHttpBase(url)}/rpc/providers`;
    try {
      const { data } = await axios.get(providersUrl, { timeout: 5000 });
      const providers = Array.isArray(data?.providers) ? data.providers : [];
      const advertised = providers.some((provider: any) => String(provider?.nodeId || '') === this.rpcNodeId);
      health.state = advertised ? 'advertised' : 'missing';
      health.lastRegistryError = null;
      if (advertised) health.lastRegistryConfirmedAt = Date.now();
      return advertised;
    } catch (error: any) {
      health.state = 'registry-unreachable';
      health.lastRegistryError = error?.message || String(error);
      console.log(`[tl-collator peer ${url}] registry check failed: ${error?.message || error}`);
      return null;
    }
  }

  private async restartPeerIfMissingFromRegistry(url: string): Promise<void> {
    const advertised = await this.isAdvertisedInRegistry(url);
    if (advertised !== false) return;

    console.log(`[tl-collator peer ${url}] server registry missing ${this.rpcNodeId}; restarting peer`);
    this.healthFor(url).restartCount += 1;
    this.stopPeer(url);
    this.lastPeerFailureAt.delete(url);
    this.startPeer(url);
  }

  async sync(status: TradeLayerSyncStatus): Promise<void> {
    if (this.syncInProgress) {
      this.syncQueue = status;
      return;
    }

    this.syncInProgress = true;
    this.lastSyncAt = Date.now();
    try {
      const desiredUrls = this.shouldContribute(status) ? Array.from(new Set(this.collatorUrls)) : [];
      const desired = new Set(desiredUrls);
      this.lastSyncStatus = status;
      this.desiredPeerUrls = desired;
      this.updateHealthMonitor();

      for (const url of Array.from(this.peers.keys())) {
        if (!desired.has(url)) {
          this.clearRecoveryTimer(url);
          this.stopPeer(url);
        }
      }

      for (const url of desiredUrls) {
        try {
          this.startPeer(url);
          await this.restartPeerIfMissingFromRegistry(url);
        } catch (error: any) {
          console.log(`[tl-collator peer ${url}] ${error?.message || error}`);
        }
      }
    } finally {
      this.syncInProgress = false;
      if (this.syncQueue) {
        const queued = this.syncQueue;
        this.syncQueue = null;
        await this.sync(queued);
      }
    }
  }

  async stop(): Promise<void> {
    this.desiredPeerUrls.clear();
    this.lastSyncStatus = null;
    this.updateHealthMonitor();
    for (const url of Array.from(this.recoveryTimers.keys())) {
      this.clearRecoveryTimer(url);
    }
    const urls = Array.from(this.peers.keys());
    for (const url of urls) {
      this.stopPeer(url);
    }
    this.peers.clear();
    this.lastPeerFailureAt.clear();
  }

  status() {
    return {
      autoContributeEnabled: this.autoContributeEnabled,
      listenerUrl: this.listenerUrl,
      walletRpcUrl: this.walletRpcUrl,
      collatorUrls: this.collatorUrls,
      activePeers: Array.from(this.peers.keys()),
      peers: this.collatorUrls.map((url) => {
        const peer = this.peers.get(url);
        const health = this.healthFor(url);
        return {
          ...health,
          active: !!peer && this.isPeerHealthy(peer.child),
          pid: peer?.child.pid ?? null,
          uptimeMs: peer ? Date.now() - peer.startedAt : 0,
          lastFailureAt: this.lastPeerFailureAt.get(url) || null,
        };
      }),
      shouldContributeReason: this.lastShouldContributeReason,
      activePeerCount: this.peers.size,
      rpcService: this.rpcService,
      rpcNetwork: this.rpcNetwork,
      rpcNodeId: this.rpcNodeId,
      advertisedMethods: ADVERTISED_PROVIDER_METHODS.map(({ method }) => method),
      retry: {
        peerRetryCooldownMs: PEER_RETRY_COOLDOWN_MS,
        registryGraceMs: PEER_REGISTRY_GRACE_MS,
        registryCheckIntervalMs: PEER_REGISTRY_CHECK_INTERVAL_MS,
        advertiseIntervalMs: PEER_ADVERTISE_INTERVAL_MS,
        healthMonitorIntervalMs: PEER_HEALTH_MONITOR_INTERVAL_MS,
        cleanExitRecoveryDelayMs: PEER_CLEAN_EXIT_RECOVERY_DELAY_MS,
      },
      lastSyncAt: this.lastSyncAt,
    };
  }
}
