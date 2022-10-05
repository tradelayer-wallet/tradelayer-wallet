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
                const fullEventName = `${eventPrefix}::${event}`;
                this.walletSocket.emit(fullEventName);
            });
        });
    }

    get walletSocket() {
        return fasitfyServer.mainSocketService.currentSocket
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

        [...orderEvents].forEach(eventName => {
            this.socket.on(eventName, (data: any) => {
                const fullEventName = `${eventPrefix}::${eventName}`;
                this.walletSocket.emit(fullEventName, data);
            });
        });

        //from Wallet ToServer;
        ["update-orderbook", "new-order", "close-order", 'many-orders'].forEach(eventName => {
            this.walletSocket.on(eventName, (data: any) => {
                this.socket.emit(eventName, data);
            });
        });


        const swapEventName = 'swap';
        this.walletSocket.on(`${this.socket.id}::${swapEventName}`, (data) => {
            this.socket.emit(`${this.socket.id}::${swapEventName}`, data);
        });

        this.socket.on('new-channel', (d) => {
            const isBuyer = d.buyerSocketId === this.socket.id;
            const cpSocketId = isBuyer ? d.sellerSocketId : d.buyerSocketId;
            this.socket.removeAllListeners(`${cpSocketId}::${swapEventName}`);
            this.socket.on(`${cpSocketId}::${swapEventName}`, (data) => {
                this.walletSocket.emit(`${cpSocketId}::${swapEventName}`, data);
            });
        });
    }
}