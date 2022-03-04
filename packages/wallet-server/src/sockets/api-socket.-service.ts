import { io, Socket as SocketClient } from 'socket.io-client';
import { clearApiService, walletSocketSevice, myVersions } from '.';

export class ApiSocketService {
    public socket: SocketClient;
    public isTestnet: boolean;

    constructor(isTestnet: boolean) {
        this.isTestnet = isTestnet;
        const url = isTestnet
            ? "http://ec2-13-40-194-140.eu-west-2.compute.amazonaws.com"
            : "http://170.187.147.182";
        const host = `${url}:77`;
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
            this.socket.emit('check-versions', myVersions);
        });

        this.socket.on('version-guard', (valid: boolean) => {
            valid
                ? walletSocketSevice.io.emit('api_connect')
                : walletSocketSevice.io.emit('need-update');
        });

        this.socket.on('disconnect', () => {
            walletSocketSevice.io.emit('api_disconnect');

        });

        this.socket.on('connect_error', () => {
            walletSocketSevice.io.emit('api_connect_error');
        });

        this.socket.on('newBlock', (block) => {
            walletSocketSevice.currentSocket.emit('newBlock-api', block)
        })
    }
    
    private handleFromApiToWallet(eventName: string) {
        this.socket.on(eventName, (data: any) => walletSocketSevice.currentSocket.emit(eventName, data));
    }
}
