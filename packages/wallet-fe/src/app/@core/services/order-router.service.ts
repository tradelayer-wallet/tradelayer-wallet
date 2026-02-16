import { Injectable } from '@angular/core';
import { P2PSettingsService } from './p2p-settings.service';
import { P2PTransportService } from './p2p-transport.service';
import { SocketService } from './socket.service';
import { AuthService } from './auth.service';
import { RpcService } from './rpc.service';
import { ClearlistService } from './clearlist.service';
import type { ConnectivityMode } from 'src/p2p/policy/RoutingPolicy';
import type { OrderBodyV1, OrderEnvelopeV1 } from 'src/p2p/types';
import { buildEnvelope, computeOrderId, randomNonceHex, signOrderIdWithPrivKeyHex } from 'src/p2p/crypto';

@Injectable({ providedIn: 'root' })
export class OrderRouterService {
  constructor(
    private socketService: SocketService,
    private settings: P2PSettingsService,
    private p2p: P2PTransportService,
    private auth: AuthService,
    private rpc: RpcService,
    private clearlist: ClearlistService
  ) {}

  mode(): ConnectivityMode {
    return this.settings.mode;
  }

  // Route a legacy wallet orderconf into the P2P bulletin-board envelope (MVP: NEW only).
  private async toEnvelopeNew(orderConf: any): Promise<OrderEnvelopeV1> {
    const address = orderConf?.keypair?.address;
    const pubkey = orderConf?.keypair?.pubkey;
    const privkey = address ? this.auth.listOfallAddresses?.find((e) => e.address === address)?.privkey : null;
    if (!pubkey) throw new Error('Missing pubkey for P2P submit');
    if (!privkey) throw new Error('Missing privkey for P2P submit');

    const px = String(orderConf?.props?.price);
    const qty = String(orderConf?.props?.amount);
    const rawMarket = String(orderConf?.marketName || '');
    const typ = String(orderConf?.type || '').toUpperCase();
    const market = rawMarket.includes(':')
      ? rawMarket
      : typ === 'FUTURES'
        ? `FUT:${rawMarket}`
        : `SPOT:${rawMarket}`;
    const side = String(orderConf?.action || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    if (!market) throw new Error('Missing marketName for P2P submit');

    const visibility = orderConf?.visibility || orderConf?.props?.visibility || { kind: 'PUBLIC' };
    const body: OrderBodyV1 = {
      v: 1,
      market,
      side,
      px,
      qty,
      visibility,
      clientTs: Date.now(),
    };

    const nonce = randomNonceHex(16);
    const orderId = computeOrderId(body, pubkey, nonce);
    const sigTrader = await signOrderIdWithPrivKeyHex(orderId, privkey);
    return buildEnvelope('NEW', body, pubkey, nonce, sigTrader);
  }

  private looksLikeOrderIdHex(s: string): boolean {
    const v = String(s || '').trim();
    return /^[0-9a-fA-F]{64}$/.test(v);
  }

  private async buildCancelEnvelope(orderIdToCancel: string, scope: 'SPOT' | 'FUTURES'): Promise<OrderEnvelopeV1> {
    const kp = scope === 'FUTURES' ? this.auth.activeFuturesKey : this.auth.activeSpotKey;
    const pubkey = kp?.pubkey;
    const privkey = kp?.privkey;
    if (!pubkey) throw new Error('Missing active pubkey for P2P cancel');
    if (!privkey) throw new Error('Missing active privkey for P2P cancel');

    const meta = this.p2p.getOrderMeta(orderIdToCancel);
    const body: OrderBodyV1 = {
      v: 1,
      market: meta?.market || '',
      side: meta?.side || 'BUY',
      px: '0',
      qty: '0',
      visibility: (meta?.visibility as any) || { kind: 'PUBLIC' },
      clientTs: Date.now(),
    };

    const nonce = randomNonceHex(16);
    const orderId = computeOrderId(body, pubkey, nonce);
    const sigTrader = await signOrderIdWithPrivKeyHex(orderId, privkey);
    return buildEnvelope('CANCEL', body, pubkey, nonce, sigTrader, { cancelsOrderId: orderIdToCancel });
  }

  async submitNewOrder(orderConf: any): Promise<void> {
    const mode = this.mode();
    if (mode === 'CENTRAL') {
      this.socketService.socket.emit('new-order', orderConf);
      return;
    }

    // Hybrid + P2P both submit to the bulletin board.
    const env = await this.toEnvelopeNew(orderConf);

    // Optional MM-only hardening: require the submitter to be clearlisted for gated pools.
    // Default OFF to preserve "retail can trade with clearlisted MM" (clearlist enforcement is applied at commit/settlement time).
    if (this.settings.enforceClearlistSubmitter) {
      const vis: any = env.body.visibility as any;
      if (vis?.kind === 'CLEARLIST' || vis?.kind === 'DARK') {
        const groupId = String(vis.groupId || '');
        const pubkey = env.traderPubKey;
        if (!groupId) throw new Error('Missing clearlist groupId');
        const res = await this.clearlist.check(groupId, pubkey);
        if (!res.allowed) throw new Error('Not clearlisted');
      }
    }

    if (!this.p2p.isConnected) {
      await this.p2p.start();
    }
    const p2pPromise = this.p2p.submit(env);

    if (mode === 'HYBRID') {
      // Best-effort double-route. Central path is authoritative for now.
      this.socketService.socket.emit('new-order', orderConf);
      try {
        await p2pPromise;
      } catch {
        // Ignore P2P errors in Hybrid MVP.
      }
      return;
    }

    // P2P-only
    await p2pPromise;
  }

  async submitManyOrders(orderConfs: any[]): Promise<void> {
    const mode = this.mode();
    if (mode === 'CENTRAL') {
      this.socketService.socket.emit('many-orders', orderConfs);
      return;
    }

    // MVP: emit each order as its own envelope over P2P.
    if (!this.p2p.isConnected) {
      await this.p2p.start();
    }
    const envs = await Promise.all((orderConfs || []).map((c) => this.toEnvelopeNew(c)));
    const p = Promise.all(envs.map((e) => this.p2p.submit(e)));

    if (mode === 'HYBRID') {
      this.socketService.socket.emit('many-orders', orderConfs);
      try {
        await p;
      } catch {}
      return;
    }
    await p;
  }

  closeOpenedOrder(id: string, scope: 'SPOT' | 'FUTURES' = 'SPOT') {
    const mode = this.mode();
    const s = String(id || '').trim();

    // CENTRAL: always close by server uuid.
    if (mode === 'CENTRAL') {
      this.socketService.socket.emit('close-order', s);
      return;
    }

    // HYBRID: if it looks like a server UUID, close centrally; if it looks like a P2P orderId, cancel via P2P.
    // P2P-only: only support P2P orderId cancels.
    if (!this.looksLikeOrderIdHex(s)) {
      if (mode === 'HYBRID') {
        this.socketService.socket.emit('close-order', s);
      }
      return;
    }

    void (async () => {
      if (!this.p2p.isConnected) await this.p2p.start();
      const env = await this.buildCancelEnvelope(s, scope);
      await this.p2p.submit(env);
    })();
  }
}
