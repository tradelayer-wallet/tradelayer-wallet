import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import { hostname } from 'os';
import { dirname, join, resolve } from 'path';

import type { TradeLayerSyncStatus } from './tradelayer-sync.service';

type PeerProc = {
  url: string;
  child: ChildProcess;
};

const DEFAULT_COLLATORS = [
  'ws://127.0.0.1:8787/ws',
  'ws://127.0.0.1:8788/ws',
];
const PEER_RETRY_COOLDOWN_MS = 60_000;

function trimSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

function splitUrls(value: string): string[] {
  return String(value || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
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
  private lastPeerFailureAt = new Map<string, number>();
  private syncInProgress = false;
  private syncQueue: TradeLayerSyncStatus | null = null;
  private lastShouldContributeReason = 'not evaluated';

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
  }

  private startPeer(url: string) {
    const lastFailedAt = this.lastPeerFailureAt.get(url) || 0;
    if (lastFailedAt && Date.now() - lastFailedAt < PEER_RETRY_COOLDOWN_MS) {
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
        RPC_METHODS_JSON: JSON.stringify([
          'getaddressinfo',
          'importpubkey',
          'listunspent',
          'getblockchaininfo',
          'validateaddress',
          'tl_getStateSnapshot',
          'tl_getSyncStatus',
          'tl_getAllBalancesForAddress',
          'tl_getChannel',
          'tl_getChannelColumn',
          'tl_getContractInfo',
          'tl_getAttestations',
          'tl_getTransaction',
          'tl_getClearlistById',
          'tl_listContractSeries',
          'tl_getInitMargin',
          'tl_channelBalanceForCommiter',
          'tl_getMaxSynth',
          'tl_contractPosition',
          'tl_tokenTradeHistoryForAddress',
          'tl_contractTradeHistoryForAddress',
          'tl_totalTradeHistoryForAddress',
          'tl_getInfo',
          'tl_getBalance',
          'tl_getProperty',
          'tl_listProperties',
        ]),
      },
      windowsHide: true,
    });

    this.peers.set(url, { url, child });

    child.stdout.on('data', (data) => {
      const text = String(data || '').trim();
      if (text) console.log(`[tl-collator peer ${url}] ${text}`);
    });

    child.stderr.on('data', (data) => {
      const text = String(data || '').trim();
      if (text) console.log(`[tl-collator peer ${url}][stderr] ${text}`);
    });

    child.once('exit', (code, signal) => {
      this.peers.delete(url);
      if (code !== 0 || signal) {
        this.lastPeerFailureAt.set(url, Date.now());
      }
      console.log(`[tl-collator peer ${url}] exited code=${code} signal=${signal}`);
    });

    child.once('error', (error) => {
      this.peers.delete(url);
      this.lastPeerFailureAt.set(url, Date.now());
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

  async sync(status: TradeLayerSyncStatus): Promise<void> {
    if (this.syncInProgress) {
      this.syncQueue = status;
      return;
    }

    this.syncInProgress = true;
    try {
      const desiredUrls = this.shouldContribute(status) ? Array.from(new Set(this.collatorUrls)) : [];
      const desired = new Set(desiredUrls);

      for (const url of Array.from(this.peers.keys())) {
        if (!desired.has(url)) {
          this.stopPeer(url);
        }
      }

      for (const url of desiredUrls) {
        try {
          this.startPeer(url);
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
      shouldContributeReason: this.lastShouldContributeReason,
      activePeerCount: this.peers.size,
      rpcService: this.rpcService,
      rpcNetwork: this.rpcNetwork,
    };
  }
}
