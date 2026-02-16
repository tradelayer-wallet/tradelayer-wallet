import { Injectable, NgZone } from '@angular/core';
import { Subscription } from 'rxjs';
import { AuthService } from './auth.service';
import { P2PSettingsService } from './p2p-settings.service';
import { P2PTransportService } from './p2p-transport.service';
import type { OrderEnvelopeV1, TapeEntryV1 } from 'src/p2p/types';

type Scope = 'SPOT' | 'FUTURES';

interface ViewOrder {
  uuid: string; // reuse existing UI "uuid" slot: for P2P this is the orderId
  marketName: string;
  action: 'BUY' | 'SELL';
  timestamp: number;
  type: Scope;
  keypair: { address: string; pubkey: string };
  lock: boolean;
  props: any;
}

function scopeFromMarket(market: string): Scope {
  const s = String(market || '');
  if (s.startsWith('FUT:') || s.startsWith('FUTURES:')) return 'FUTURES';
  if (s.startsWith('SPOT:')) return 'SPOT';
  // Default to SPOT for backward compatibility.
  return 'SPOT';
}

@Injectable({ providedIn: 'root' })
export class P2PMyOrdersService {
  private sub: Subscription | null = null;
  private activeByOrderId = new Map<string, { env: OrderEnvelopeV1; ts: number }>();

  constructor(
    private p2p: P2PTransportService,
    private auth: AuthService,
    private settings: P2PSettingsService,
    private zone: NgZone
  ) {
    this.sub = this.p2p.tape$.subscribe((e) => {
      if (!e) return;
      // WebRTC callbacks may happen outside Angular zone; re-enter so views update.
      this.zone.run(() => this.onEntry(e));
    });
  }

  private onEntry(e: TapeEntryV1) {
    const env = e.order;
    if (!env || typeof env.orderId !== 'string') return;

    if (env.kind === 'NEW') {
      this.activeByOrderId.set(env.orderId, { env, ts: env.body?.clientTs || e.receivedTs || Date.now() });
      return;
    }

    if (env.kind === 'CANCEL') {
      const target = String(env.cancelsOrderId || '').trim();
      if (target) this.activeByOrderId.delete(target);
      return;
    }

    if (env.kind === 'REPLACE') {
      const target = String(env.replacesOrderId || '').trim();
      if (target) this.activeByOrderId.delete(target);
      // REPLACE is also a NEW for the new orderId.
      this.activeByOrderId.set(env.orderId, { env, ts: env.body?.clientTs || e.receivedTs || Date.now() });
      return;
    }
  }

  // Used by legacy tables; returns objects shaped like existing spot/futures order entries.
  getOpened(scope: Scope): any[] {
    const mode = this.settings.mode;
    if (mode === 'CENTRAL') return [];

    const kp = scope === 'FUTURES' ? this.auth.activeFuturesKey : this.auth.activeSpotKey;
    const pubkey = kp?.pubkey;
    const address = kp?.address || '';
    if (!pubkey) return [];

    const out: ViewOrder[] = [];
    for (const { env, ts } of this.activeByOrderId.values()) {
      if (env.traderPubKey !== pubkey) continue;
      const mkt = String(env.body?.market || '');
      if (scopeFromMarket(mkt) !== scope) continue;

      const px = String(env.body?.px ?? '0');
      const qty = String(env.body?.qty ?? '0');
      const marketName = mkt.includes(':') ? mkt.split(':').slice(1).join(':') : mkt;
      out.push({
        uuid: env.orderId, // pass orderId through existing cancel button path
        marketName,
        action: env.body?.side === 'SELL' ? 'SELL' : 'BUY',
        timestamp: ts,
        type: scope,
        keypair: { address, pubkey },
        lock: false,
        props:
          scope === 'FUTURES'
            ? { contract_id: 0, amount: Number(qty) || 0, price: Number(px) || 0, levarage: 0, collateral: 0 }
            : { id_desired: 0, id_for_sale: 0, amount: Number(qty) || 0, price: Number(px) || 0 },
      });
    }

    // Newest first for UX.
    out.sort((a, b) => b.timestamp - a.timestamp);
    return out;
  }
}
