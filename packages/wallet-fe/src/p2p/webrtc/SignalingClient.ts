type WsFactory = (url: string) => WebSocket;

export type SignalMsg =
  | { t: 'SIGNAL_HELLO'; v: 1; clientId: string }
  | { t: 'SIGNAL_OFFER'; v: 1; sdp: string; kind: 'offer' }
  | { t: 'SIGNAL_ANSWER'; v: 1; sdp: string; kind: 'answer' }
  | { t: 'SIGNAL_ICE'; v: 1; candidate: RTCIceCandidateInit }
  | { t: 'SIGNAL_ERR'; v: 1; code: string; msg: string };

function defaultWsFactory(url: string): WebSocket {
  // Browser/Electron renderer.
  const g: any = globalThis as any;
  if (typeof g.WebSocket === 'function') return new g.WebSocket(url);
  throw new Error(`WebSocket is not available in this environment (url=${url})`);
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private wsFactory: WsFactory;

  constructor(wsFactory?: WsFactory) {
    this.wsFactory = wsFactory || defaultWsFactory;
  }

  get connectedUrl(): string | null {
    return this.url;
  }

  async connect(url: string, timeoutMs: number = 15000): Promise<void> {
    await this.disconnect();
    this.url = url;
    console.log(`[p2p][signal] connecting ws=${url}`);
    const ws = this.wsFactory(url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`signaling connect timeout ws=${url}`)), timeoutMs);
      ws.onopen = () => {
        clearTimeout(to);
        console.log(`[p2p][signal] open ws=${url}`);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(to);
        console.warn(`[p2p][signal] error ws=${url}`);
        reject(new Error(`signaling connect failed ws=${url}`));
      };
      ws.onclose = (ev: CloseEvent) => {
        console.log(`[p2p][signal] closed ws=${url} code=${ev.code} reason=${ev.reason || ''}`.trim());
      };
    });
  }

  async disconnect(): Promise<void> {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    this.url = null;
    try {
      ws.close();
    } catch {}
  }

  send(msg: SignalMsg) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('signaling not connected');
    console.log(`[p2p][signal] send ${msg?.t || 'UNKNOWN'} ws=${this.url || '-'}`);
    this.ws.send(JSON.stringify(msg));
  }

  onMessage(cb: (msg: SignalMsg) => void): () => void {
    if (!this.ws) throw new Error('signaling not connected');
    const ws = this.ws;
    const handler = (ev: any) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
        const msg = JSON.parse(raw) as SignalMsg;
        cb(msg);
      } catch {}
    };
    (ws as any).onmessage = handler;
    return () => {
      try {
        (ws as any).onmessage = null;
      } catch {}
    };
  }
}
