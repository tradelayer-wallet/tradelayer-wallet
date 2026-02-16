import type { PeerTransport, PeerTransportStatus } from '../PeerTransport';
import type { OrderEnvelopeV1, TapeEntryV1, WireMsg } from '../types';
import { DataChannelMux } from './DataChannelMux';
import { SignalingClient } from './SignalingClient';
import type { SignalMsg } from './SignalingClient';

function nowMs() {
  return Date.now();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function randId(): string {
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

export class WebRTCTransport implements PeerTransport {
  private collatorUrls: string[];
  private clientId: string;
  private signaling: SignalingClient;
  private initialFromSeq: number | null = null;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mux: DataChannelMux | null = null;
  private tapeSubs: Set<(e: TapeEntryV1) => void> = new Set();

  private status: PeerTransportStatus = { mode: 'P2P', connected: false };
  private lastPingAt: number | null = null;
  private lastPongAt: number | null = null;

  constructor(opts: {
    collatorUrls: string[];
    clientId?: string;
    signaling?: SignalingClient;
    fromSeq?: number;
  }) {
    this.collatorUrls = (opts.collatorUrls || []).filter(Boolean);
    this.clientId = opts.clientId || `tlw-${randId()}`;
    this.signaling = opts.signaling || new SignalingClient();
    this.initialFromSeq = typeof opts.fromSeq === 'number' ? opts.fromSeq : null;
  }

  isReady(): boolean {
    return !!this.mux?.isOpen();
  }

  getStatus(): PeerTransportStatus {
    return { ...this.status };
  }

  subscribeTape(cb: (entry: TapeEntryV1) => void): () => void {
    this.tapeSubs.add(cb);
    return () => this.tapeSubs.delete(cb);
  }

  async start(): Promise<void> {
    if (this.isReady()) return;
    if (!this.collatorUrls.length) throw new Error('no collator urls configured');

    // Try each collator URL sequentially; keep the first that completes handshake.
    let lastErr: any = null;
    for (const url of this.collatorUrls) {
      try {
        await this.startWithCollator(url);
        return;
      } catch (e) {
        lastErr = e;
        await this.safeStop();
      }
    }
    throw lastErr || new Error('no collator reachable');
  }

  async stop(): Promise<void> {
    await this.safeStop();
  }

  private async safeStop() {
    this.status = { mode: 'P2P', connected: false };
    this.lastPingAt = null;
    this.lastPongAt = null;
    try {
      this.mux?.close();
    } catch {}
    this.mux = null;
    try {
      this.dc?.close();
    } catch {}
    this.dc = null;
    try {
      this.pc?.close();
    } catch {}
    this.pc = null;
    try {
      await this.signaling.disconnect();
    } catch {}
  }

  private async startWithCollator(signalingUrl: string): Promise<void> {
    await this.signaling.connect(signalingUrl, 15000);
    this.status.collatorUrl = signalingUrl;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
    });
    this.pc = pc;

    // DataChannel: ordered+reliable for MVP RPC/tape.
    const dc = pc.createDataChannel('tl-bb', { ordered: true });
    this.dc = dc;

    // Wire up ICE candidate forwarding to signaling.
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const msg: SignalMsg = { t: 'SIGNAL_ICE', v: 1, candidate: ev.candidate.toJSON() };
      try {
        this.signaling.send(msg);
      } catch {}
    };

    // Handle signaling messages.
    this.signaling.onMessage(async (msg) => {
      if (!this.pc) return;
      if (msg.t === 'SIGNAL_ANSWER') {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      } else if (msg.t === 'SIGNAL_ICE') {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch {}
      } else if (msg.t === 'SIGNAL_ERR') {
        // Surface as disconnect; higher-level will retry/failover if needed.
        await this.safeStop();
      }
    });

    // Kick off offer.
    this.signaling.send({ t: 'SIGNAL_HELLO', v: 1, clientId: this.clientId });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.send({ t: 'SIGNAL_OFFER', v: 1, kind: 'offer', sdp: offer.sdp || '' });

    // Wait for DataChannel open.
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('datachannel open timeout')), 20000);
      dc.onopen = () => {
        clearTimeout(to);
        resolve();
      };
      dc.onerror = () => {
        clearTimeout(to);
        reject(new Error('datachannel error'));
      };
    });

    const mux = new DataChannelMux(dc);
    this.mux = mux;

    mux.onMessage((m: WireMsg) => {
      if (m.t === 'TAPE_ENTRY') {
        for (const cb of this.tapeSubs) cb(m.entry);
      } else if (m.t === 'PONG') {
        this.lastPongAt = nowMs();
        this.status.lastPongAtMs = this.lastPongAt;
        if (this.lastPingAt) this.status.rttMs = Math.max(0, nowMs() - this.lastPingAt);
      } else if (m.t === 'ERR') {
        // No-op for MVP; caller can subscribe to logs.
      }
    });

    // Announce intent.
    mux.send({ t: 'HELLO', v: 1, clientId: this.clientId, want: ['TAPE', 'SUBMIT'] });
    const fromSeq = this.initialFromSeq;
    mux.send(fromSeq && fromSeq > 1 ? { t: 'TAPE_SUB', v: 1, fromSeq } : { t: 'TAPE_SUB', v: 1 });
    this.status.connected = true;
    this.status.peerId = this.clientId;
    this.lastPongAt = nowMs();
    this.status.lastPongAtMs = this.lastPongAt;

    // Simple ping loop.
    void (async () => {
      while (this.isReady()) {
        await sleep(5000);
        if (!this.mux?.isOpen()) break;
        this.lastPingAt = nowMs();
        try {
          this.mux.send({ t: 'PING', v: 1, ts: this.lastPingAt });
        } catch {}
      }
    })();
  }

  async submit(order: OrderEnvelopeV1): Promise<void> {
    if (!this.mux?.isOpen()) throw new Error('p2p transport not ready');
    this.mux.send({ t: 'SUBMIT', v: 1, order });
  }
}
