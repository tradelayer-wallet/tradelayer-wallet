import { io, Socket as SocketClient } from 'socket.io-client';
import { fasitfyServer } from '..';

export interface IOBSocketServiceOptions {
    url: string;
}

const eventPrefix = 'OB_SOCKET'
export class OBSocketService {
    public socket: SocketClient;

    constructor(
        private options: IOBSocketServiceOptions,
    ) {
        this.socket = io(this.options.url, { reconnection: false });
        const mainEvents = ['connect', 'disconnect', 'connect_error'];

        mainEvents.forEach(event => {
            this.socket.on(event, () => {
                if (event === 'connect') this.handleEvents();
                this.toWallet(`${eventPrefix}::${event}`);
            });
        });
    }

    // The wallet's current socket. Null once the wallet side is torn down; events are then dropped.
    get walletSocket() {
        return fasitfyServer.mainSocketService?.currentSocket ?? null;
    }

    private toWallet(eventName: string, ...args: any[]) {
        this.walletSocket?.emit(eventName, ...args);
    }

    private handleEvents() {
        // from Server To wallet;
        const orderEvents = [
            'order:error',
            'order:saved',
            'placed-orders',
            'orderbook-data',
            'update-orders-request',
            'new-channel',
        ];

        orderEvents.forEach(eventName => {
            this.socket.on(eventName, (data: any) => this.toWallet(`${eventPrefix}::${eventName}`, data));
        });

        //from Wallet ToServer;
        ["update-orderbook", "new-order", "close-order", 'many-orders'].forEach(eventName => {
            this.walletSocket?.on(eventName, (data: any) => {
                this.socket.emit(eventName, data);
            });
        });


        // Swap events are not keyed by socket. Both directions use the single `swap`
        // event, relayed unchanged; the orderbook server routes them by sessionId.
        this.walletSocket?.on('swap', (data) => {
            this.socket.emit('swap', data);
        });
        this.socket.on('swap', (data) => {
            this.toWallet('swap', data);
        });
    }
}