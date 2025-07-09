import WebSocket from 'ws';
import { fasitfyServer } from '..';   // same import the old file used


export interface IOBSocketServiceOptions {
  url: string;
}

const eventPrefix = 'OB_SOCKET';

export class OBSocketService {
  private ws!: WebSocket;
  private reconnectAttempts = 0;
  private clientId: string | null = null;

    constructor(private options: IOBSocketServiceOptions) {
       this.connect();
    }

    public get socket(): any {
    if (!this.ws) return null;
    const sock: any = this.ws;
    // no-ops so old code compiles & runs
    sock.offAny     ??= () => {};
    sock.disconnect ??= () => this.ws.close();
    return sock;
   }

    /* Fastify-hosted Socket.IO connection that the renderer is already using */
    private get walletSocket() {
      return fasitfyServer.mainSocketService.currentSocket;
    }

  // ────────────────────────────────────────────  WS connect / retry
  private connect() {
    this.ws = new WebSocket(this.options.url);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.walletSocket?.emit(`${eventPrefix}::connect`);
      this.bridgeWalletToServer();           // set up listeners once
    });

    this.ws.on('message', (buf) => this.handleServer(JSON.parse(buf.toString())));
    this.ws.on('close', () =>  this.scheduleReconnect('disconnect'));
    this.ws.on('error', () =>  this.scheduleReconnect('connect_error'));
  }

  private scheduleReconnect(event: string) {
    this.walletSocket?.emit(`${eventPrefix}::${event}`);
    this.reconnectAttempts += 1;
    const delay = Math.min(1_000 * this.reconnectAttempts ** 2, 30_000);
    setTimeout(() => this.connect(), delay);
  }

  // ───────────────────────────────────────────────  keep-alive
  private heartbeat = setInterval(() => {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ event: 'ping' }));
  }, 15_000);

  // ───────────────────────────────────────────────  Server → Wallet
  private handleServer(msg: any) {
    if (!msg?.event) return;

    /* capture our own id if the server sends it once */
    if (!this.clientId && msg.socketId) this.clientId = msg.socketId;

    this.walletSocket?.emit(`${eventPrefix}::${msg.event}`, msg);

    // special “new-channel” handling (mirrors the old logic)
    if (msg.event === 'new-channel') {
      const cpId = msg.isBuyer
        ? msg.tradeInfo.seller.socketId
        : msg.tradeInfo.buyer.socketId;
      this.rebindSwapChannel(cpId);
    }
  }

  // ───────────────────────────────────────────────  Wallet → Server
  private bridgeWalletToServer() {
    ['update-orderbook', 'new-order', 'close-order', 'many-orders'].forEach((ev) => {
      this.walletSocket?.on(ev, (data: any) => this.emitToServer(ev, data));
    });

    /* start listening for our own swap namespace once we know the id */
    if (this.clientId) this.rebindSwapChannel(this.clientId);
  }

  private rebindSwapChannel(socketId: string) {
   const swapEvt = `${socketId}::swap`;
    // Node/EventEmitter wants both args; easiest is to wipe all listeners:
    this.walletSocket?.removeAllListeners?.(swapEvt);
    this.walletSocket?.on(swapEvt, (data: any) => this.emitToServer(swapEvt, data));
  }

  private emitToServer(event: string, payload: any = {}) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ event, ...payload }));
  }
}
