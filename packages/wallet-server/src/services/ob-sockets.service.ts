import WebSocket from 'ws';
import { fasitfyServer } from '..';

export interface IOBSocketServiceOptions {
  url: string;
}

const eventPrefix = 'OB_SOCKET';

export class OBSocketService {
  private ws!: WebSocket;
  private isConnecting = false;
  private reconnectAttempts = 0;
  // Canonical id received from server after connection
  private _clientId: string | null = null;
  private activeSwapListeners: Map<string, (...args: any[]) => void> = new Map();
  private _handlers: { [event: string]: (data: any) => void } = {};
  private _onAnyHandler?: (event: string, data: any) => void;

  constructor(private options: IOBSocketServiceOptions) {
    this.bridgeWalletToServer();
    this.connect();
  }

  public get socket(): any {
    if (!this.ws) return null;
    const sock: any = this.ws;
    sock.offAny ??= () => {};
    sock.disconnect ??= () => this.ws.close();
    return sock;
  }

  public get clientId(): string | null {
    return this._clientId;
  }

  private get walletSocket() {
    return fasitfyServer.mainSocketService.currentSocket;
  }

  /** Establish (or re‑establish) the WebSocket connection to the OB server. */
  private connect() {
   if (
      this.isConnecting ||
      (this.ws && (this.ws.readyState === WebSocket.OPEN ||
             this.ws.readyState === WebSocket.CONNECTING))
    ) {
      return;
    }
    console.log('inside connect')

    this.isConnecting = true;
    this.ws = new WebSocket(this.options.url);

    this.ws.on('open', () => {
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      // No longer emit socketId here! Just signal connect event.
      this.walletSocket?.emit(`${eventPrefix}::connect`);
    });

    this.ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch (e) {
        console.error('[OB WS] JSON parse error:', e);
        return;
      }
      this.handleServer(msg);
    });

    this.ws.on('close', () => this.walletSocket?.emit(`${eventPrefix}::disconnect`));
    this.ws.on('error', () => this.scheduleReconnect('connect_error'));
  }

  private scheduleReconnect(event: string) {
    this.walletSocket?.emit(`${eventPrefix}::${event}`);
    this.reconnectAttempts += 1;

    // Clean up every listener on the old socket instance and mark it dead.
    if (this.ws) {
      this.ws.removeAllListeners?.();
      try {
        this.ws.terminate?.();
      } catch {}
    }
    this.ws = undefined as any;
    this.isConnecting = false;

    // Quadratic back‑off: 1 s, 4 s, 9 s … capped at 30 s.
    const delay = Math.min(1_000 * this.reconnectAttempts ** 2, 30_000);
    setTimeout(() => this.connect(), delay);
  }

  private heartbeat = setInterval(() => {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ event: 'ping' }));
  }, 15_000);

  // -------------------- SERVER → WALLET (universal handler) --------------------
  private handleServer(msg: any) {
      console.log('incoming message from OB ' + Date.now() +' '+JSON.stringify(msg));

    if (!msg?.event) return;
    // Handle id assignment from server, dedupe here.
    if (msg.event === 'connected' && msg.id) {
      if (this._clientId && this._clientId !== msg.id) {
        // If id changed, clean up listeners or state as needed
        // (optional: e.g. disconnect, warn, etc.)
        // For now just log
        console.log('[OB WS] Re-assigned id, old:', this._clientId, 'new:', msg.id);
      }
      this._clientId = msg.id;
      console.log('Connected to OB, got id:', msg.id);
      // Could emit to FE or trigger further actions here if desired
      return;
    }


    // Relay ::swap (always send through as-is)
    if (msg.event.includes('::swap')) {

      this.walletSocket?.emit(msg.event, msg.data);
      return;
    }

    // Handle new-channel event for swap/CP id cleanup
    if (msg.event === 'new-channel') {
      console.log('new channel message '+JSON.stringify(msg))
      this.handleNewChannel(msg);
      return;
    }

    // Relay all other events as OB_SOCKET::<event>
    this.walletSocket?.emit(`${eventPrefix}::${msg.event}`, msg);
  }

  private handleNewChannel(msg: any) {
    const data = msg.data || msg;

    // Clean up listeners for both relevant swap parties (by socketId)
    if (data.tradeInfo) {
      [data.tradeInfo.seller?.socketId, data.tradeInfo.buyer?.socketId].forEach(
        (socketId) => {
          if (socketId) {
            const swapEvt = `${socketId}::swap`;
            const handler = this.activeSwapListeners.get(swapEvt);
            if (handler) {
              this.walletSocket?.off(swapEvt, handler);
              this.activeSwapListeners.delete(swapEvt);
            }
          }
        }
      );
    }
    // Pass canonical new-channel event to FE (Angular)
    this.walletSocket?.emit(`${eventPrefix}::new-channel`, data);
  }

  // -------------------- WALLET → SERVER (bridge, including new-channel) -
  /** Attaches wallet‑side socket listeners (only once per socket instance). */
  private bridgeWalletToServer() {
    if (!this.walletSocket) return;

    // CLEANUP FIRST
    this.cleanupWalletSocketListeners();

    // REGULAR EVENTS
    ['update-orderbook', 'new-order', 'close-order', 'many-orders','orderbook:join', 'orderbook:leave','amend-order'].forEach(ev => {
      this._handlers[ev] = (data: any) => {
        console.log('emitting ' + JSON.stringify(data));
        this.emitToServer(ev, data);
      };
      this.walletSocket.on(ev, this._handlers[ev]);
    });

    // NEW CHANNEL EVENT
    this._handlers[`${eventPrefix}::new-channel`] = (data: any) => {
      this.emitToServer('new-channel', data);
    };
    this.walletSocket.on(`${eventPrefix}::new-channel`, this._handlers[`${eventPrefix}::new-channel`]);

    // ON ANY EVENT
    if (this._onAnyHandler) this.walletSocket.offAny(this._onAnyHandler);
    this._onAnyHandler = (event: string, data: any) => {
      if (event.endsWith('::swap')) {
        console.log('[OB WS] forwarding swap', event, data);
        this.emitToServer(event, {
          eventName: data.eventName,
          socketId: data.socketId,
          data: data.data,
        });
      }
    };
    this.walletSocket.onAny(this._onAnyHandler);
  }

  private cleanupWalletSocketListeners() {
    if (!this.walletSocket || !this._handlers) return;
    Object.keys(this._handlers).forEach(ev => {
      this.walletSocket.off(ev, this._handlers[ev]);
    });
    if (this._onAnyHandler) {
      this.walletSocket.offAny(this._onAnyHandler);
      this._onAnyHandler = undefined;
    }
    this._handlers = {};
  }

  private emitToServer(event: string, payload: any = {}) {
    console.log('emitting '+event+' '+JSON.stringify(payload))
      this.ws.send(JSON.stringify({ event, ...payload }));
  }
}
