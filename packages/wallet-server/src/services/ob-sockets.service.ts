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
        this.handleEvents();
    }

    get walletSocket() {
        return fasitfyServer.mainSocketService.currentSocket
    }

    private handleEvents() {
        // from Server To wallet;
        const mainEvents = ['connect', 'disconnect', 'connect_error'];
        const orderEvents = ['order:error', 'order:saved', 'placed-orders', 'orderbook-data', 'update-orders-request'];
        [...mainEvents, ...orderEvents].forEach(eventName => {
            this.socket.on(eventName, (data: any) => {
                console.log({ eventName });
                const fullEventName = `${eventPrefix}::${eventName}`;
                this.walletSocket.emit(fullEventName, data);
            });
        });

        //from Wallet ToServer;
        ["update-orderbook", "new-order", "close-order"].forEach(eventName => {
            this.walletSocket.on(eventName, (data: any) => {
                console.log({ eventName });
                this.socket.emit(eventName, data);
            });
        });
    }
}