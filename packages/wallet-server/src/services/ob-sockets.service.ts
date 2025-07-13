import WebSocket from 'ws';
import { fasitfyServer } from '..';

export interface IOBSocketServiceOptions {
  url: string;
}

const eventPrefix = 'OB_SOCKET';

export class OBSocketService {
  private ws!: WebSocket;
  private reconnectAttempts = 0;
  private clientId: string | null = null;

  constructor(private options: IOBSocketServiceOptions) {
    console.log('[OB WS] constructor — options:', options);
    this.bridgeWalletToServer();
    console.log('[OB WS] calling connect() now');
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
    this.ws = new WebSocket(this.options.url);

    this.ws.on('open', () => {
      console.log('[OB WS] connected to', this.options.url, 'readyState=', this.ws.readyState);
      this.reconnectAttempts = 0;
      this.walletSocket?.emit(`${eventPrefix}::connect`);
    });

    this.ws.on('message', (buf) => {
      console.log('[OB WS] raw message:', buf.toString());
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch (e) {
        console.error('[OB WS] JSON parse error:', e);
        return;
      }
      this.handleServer(msg);
    });

    this.ws.on('close', (code, reason) => {
      console.log('[OB WS] closed:', code, reason.toString());
      this.scheduleReconnect('disconnect');
    });

    this.ws.on('error', (err) => {
      console.error('[OB WS] error:', err);
      this.scheduleReconnect('connect_error');
    });
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

  // ───────────────────────────── Server → Wallet (universal handler)
  private handleServer(msg: any) {
    if (!msg?.event) return;
    console.log('[OB WS ← Server] got:', msg);

 if (msg.event && msg.event.endsWith('::swap')) {
    // Just forward to the FE with the same event name
    this.walletSocket?.emit(msg.event, msg.data);
    return; // Don't fall through to other cases
  }

    // Universal switch for debugging, notifications, or further hooks
    switch (msg.event) {
      case 'orderbook-data':
        console.log('[OB] Full orderbook:', msg.orders);
        break;
      case 'placed-orders':
        console.log('[OB] User orders:', msg.openedOrders, msg.orderHistory);
        break;
      case 'update-orders-request':
        console.log('[OB] Orderbook refresh requested');
        break;
      case 'order:saved':
        console.log('[OB] Order saved:', msg.orderUuid);
        break;
      case 'order:error':
        console.warn('[OB] Order error:', msg.error || msg);
        break;
      default:
        console.log('[OB] Unhandled event:', msg.event, msg);
    }
    // Special “new-channel” handling (mirrors old logic)
     if (msg.event === 'new-channel') {

        const data = msg.data || msg; // handle both new (.data) and legacy (flat)
        console.log('new channel msg '+JSON.stringify(msg))
        if (!data.tradeInfo || !data.tradeInfo.seller || !data.tradeInfo.buyer) {
          console.warn('[OB WS] Malformed new-channel message:', msg);
          return;
        }
        this.walletSocket?.emit(`${eventPrefix}::new-channel`, data);
        const cpId = data.isBuyer
          ? data.tradeInfo.seller.socketId
          : data.tradeInfo.buyer.socketId;
        this.rebindSwapChannel(cpId);
        return
    }

    // Always relay to FE
    this.walletSocket?.emit(`${eventPrefix}::${msg.event}`, msg);
    return
  }

  // ───────────────────────────── Wallet → Server
  private bridgeWalletToServer() {
    ['update-orderbook', 'new-order', 'close-order', 'many-orders'].forEach((ev) => {
      this.walletSocket?.on(ev, (data: any) => this.emitToServer(ev, data));
    });

    // Listen for own swap namespace once ID is set
    if (this.clientId) this.rebindSwapChannel(this.clientId);
  }

  private rebindSwapChannel(socketId: string) {
    const swapEvt = `${socketId}::swap`;
    this.walletSocket?.removeAllListeners?.(swapEvt);
    this.walletSocket?.on(swapEvt, (data: any) => this.emitToServer(swapEvt, data));
  }

  private emitToServer(event: string, payload: any = {}) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ event, ...payload }));
  }
}
