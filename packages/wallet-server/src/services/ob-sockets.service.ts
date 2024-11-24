import { WebSocket } from 'ws';
import { fasitfyServer } from '..';

export interface IOBSocketServiceOptions {
    url: string;
}

const eventPrefix = 'OB_SOCKET';

export class OBSocketService {
    public socket: WebSocket;

    constructor(
        private options: IOBSocketServiceOptions,
    ) {
        this.socket = new WebSocket(this.options.url);

        const mainEvents = ['open', 'close', 'error'];

        // Listen for WebSocket events
        mainEvents.forEach(event => {
            this.socket.addEventListener(event, () => {
                if (event === 'open') this.handleEvents();
                const fullEventName = `${eventPrefix}::${event}`;
                this.walletSocket.send(fullEventName);
            });
        });
    }

    get walletSocket() {
        return fasitfyServer.mainSocketService.currentSocket;
    }

    private handleEvents() {
        // From Server to wallet
        const orderEvents = [
            'order:error',
            'order:saved',
            'placed-orders',
            'orderbook-data',
            'update-orders-request',
            'new-channel',
        ];

        orderEvents.forEach(eventName => {
            this.socket.addEventListener('message', (event: MessageEvent) => {
                const data = JSON.parse(event.data as string);
                const fullEventName = `${eventPrefix}::${eventName}`;
                this.walletSocket.send(JSON.stringify({ event: fullEventName, data }));
            });
        });

        // From Wallet to Server
        ["update-orderbook", "new-order", "close-order", 'many-orders'].forEach(eventName => {
            this.walletSocket.addEventListener(eventName, (data: any) => {
                this.socket.send(JSON.stringify(data));
            });
        });

        const swapEventName = 'swap';
        this.walletSocket.addEventListener(`${this.socket.id}::${swapEventName}`, (data) => {
            this.socket.send(JSON.stringify({ event: `${this.socket.id}::${swapEventName}`, data }));
        });

        this.socket.addEventListener('new-channel', (d: any) => {
            const cpSocketId = d.isBuyer ? d.tradeInfo.seller.socketId : d.tradeInfo.buyer.socketId;
            this.socket.removeEventListener(`${cpSocketId}::${swapEventName}`);
            this.socket.addEventListener(`${cpSocketId}::${swapEventName}`, (data) => {
                this.walletSocket.send(JSON.stringify({ event: `${cpSocketId}::${swapEventName}`, data }));
            });
        });
    }
}
