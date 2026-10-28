import { io, Socket as SocketClient } from 'socket.io-client';
import type { Socket as WalletSocket } from 'socket.io';
import { fasitfyServer } from '..';

export interface IOBSocketServiceOptions {
    url: string;
}

const eventPrefix = 'OB_SOCKET'
// Wallet events relayed to the orderbook. Swap events are not keyed by socket; the orderbook routes them by sessionId.
const relayedFromWallet = ['update-orderbook', 'new-order', 'close-order', 'many-orders', 'swap'];

export class OBSocketService {
    public socket: SocketClient;
    private relayWallet: WalletSocket | null = null;

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

    // Binds the outbound relay to the wallet's current socket. SocketService calls this for every new wallet
    // socket, so a reconnected UI is relayed as well; the previous socket's listener is removed.
    attachWallet(wallet: WalletSocket) {
        this.relayWallet?.offAny(this.relayFromWallet);
        this.relayWallet = wallet;
        wallet.onAny(this.relayFromWallet);
    }

    private relayFromWallet = (eventName: string, data: any) => {
        if (relayedFromWallet.includes(eventName) && this.socket.connected) this.socket.emit(eventName, data);
    };

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

        const wallet = this.walletSocket;
        if (wallet) this.attachWallet(wallet);

        // Both swap directions use the single `swap` event, relayed unchanged.
        this.socket.on('swap', (data) => {
            this.toWallet('swap', data);
        });
    }
}