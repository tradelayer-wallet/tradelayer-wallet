import WebSocket from 'ws';
import { fasitfyServer } from '..';

export interface IOBSocketServiceOptions {
  url: string;
}

const eventPrefix = 'OB_SOCKET';

export class OBSocketService {
  private ws!: WebSocket;
  private reconnectAttempts = 0;
  // This is a canonical client id for *this* wallet server instance, not per trade/channel.
  private clientId: string = this.generateClientId();
  private activeSwapListeners: Map<string, (...args: any[]) => void> = new Map();

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

  private get walletSocket() {
    return fasitfyServer.mainSocketService.currentSocket;
  }

  private connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.ws = new WebSocket(this.options.url);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.walletSocket?.emit(`${eventPrefix}::connect`, { socketId: this.clientId });
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

    this.ws.on('close', () => this.scheduleReconnect('disconnect'));
    this.ws.on('error', () => this.scheduleReconnect('connect_error'));
  }

  private scheduleReconnect(event: string) {
    this.walletSocket?.emit(`${eventPrefix}::${event}`);
    this.reconnectAttempts += 1;
    const delay = Math.min(1_000 * this.reconnectAttempts ** 2, 30_000);
    setTimeout(() => this.connect(), delay);
  }

  private heartbeat = setInterval(() => {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ event: 'ping' }));
  }, 15_000);

  // Helper for unique ID per wallet session
  private generateClientId(): string {
    return Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  // -------------------- SERVER → WALLET (universal handler) --------------------
  private handleServer(msg: any) {
    if (!msg?.event) return;
    if(msg.event!='orderbook-data'){
        console.log('incoming message from OB '+JSON.stringify(msg))
    }
    // Relay ::swap (always send through as-is)
    if (msg.event.includes('::swap')) {
      // msg.data should contain the actual SwapEvent object

      this.walletSocket?.emit(msg.event, msg.data);
      return;
    }

    // Handle new-channel event for swap/CP id cleanup
    if (msg.event === 'new-channel') {
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
      [data.tradeInfo.seller?.socketId, data.tradeInfo.buyer?.socketId].forEach(socketId => {
        if (socketId) {
          const swapEvt = `${socketId}::swap`;
          const handler = this.activeSwapListeners.get(swapEvt);
          if (handler) {
            this.walletSocket?.off(swapEvt, handler);
            this.activeSwapListeners.delete(swapEvt);
          }
        }
      });
    }
    // Pass canonical new-channel event to FE (Angular)
    this.walletSocket?.emit(`${eventPrefix}::new-channel`, data);
  }

  // -------------------- WALLET → SERVER (bridge, including new-channel) -
        private bridgeWalletToServer() {
          // Relay all standard OB events
          ['update-orderbook', 'new-order', 'close-order', 'many-orders'].forEach((ev) => {
            this.walletSocket?.on(ev, (data: any) => this.emitToServer(ev, data));
          });

          // Relay new-channel event from FE to server
          this.walletSocket?.on(`${eventPrefix}::new-channel`, (data: any) => {
            this.emitToServer('new-channel', data);
          });

          // Relay any ::swap (multi-trade safe) from FE to server
          if (!(this.walletSocket as any)._obAnyAttached) {
            (this.walletSocket as any)._obAnyAttached = true;

            this.walletSocket.onAny((event: string, data: any) => {
              if (event.endsWith('::swap')) {
                console.log('emitting swap step ' + JSON.stringify(event) + JSON.stringify(data));
                // Optionally patch socketId here
                this.emitToServer(event, {eventName:data.eventName,socketId:data.socketId,data:data.data});
              }
            });
          }
        }

  // (If you need id patching logic, write it here, e.g. canonicalizeId(id: string): string {...})

  private emitToServer(event: string, payload: any = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event, ...payload }));
    }
  }
}
