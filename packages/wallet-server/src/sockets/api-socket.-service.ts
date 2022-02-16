import { io, Socket as SocketClient } from 'socket.io-client';
import { clearApiService, walletSocketSevice } from '.';

export class ApiSocketService {
    public socket: SocketClient;
    public isTestnet: boolean;

    constructor(isTestnet: boolean) {
        this.isTestnet = isTestnet;
        const url = isTestnet
            ? "testnetAPIURL"
            : "mainNETAPIURL";
        const host = `${url}:75`;
        this.socket = io(host, { reconnection: false });
        this.handleEvents();
    }

    terminate() {
        clearApiService()
        this.socket.disconnect();
        this.socket = null;
    }

    private handleEvents() {
        this.socket.on('connect', () => {
            //
        });

        this.socket.on('disconnect', () => {
            walletSocketSevice.io.emit('api_disconnect');
        });

        this.socket.on('connect_error', () => {
            walletSocketSevice.io.emit('api_connect_error');
        });
    }
    
    private handleFromApiToWallet(eventName: string) {
        this.socket.on(eventName, (data: any) => walletSocketSevice.currentSocket.emit(eventName, data));
    }
}
