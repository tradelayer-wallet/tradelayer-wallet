import { io, Socket as SocketClient } from 'socket.io-client';
import { clearApiService, walletSocketSevice } from '.';

export class ApiSocketService {
    public socket: SocketClient;
    public isTestnet: boolean;

    constructor(isTestnet: boolean) {
        this.isTestnet = isTestnet;
        const url = isTestnet
            ? "http://ec2-13-40-194-140.eu-west-2.compute.amazonaws.com"
            : "http://66.228.57.16";
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
            //
        });

        this.socket.on('disconnect', () => {
            // walletSocketSevice.io.emit('api_disconnect');
            process.send(`Disconnect`)

        });

        this.socket.on('connect_error', () => {
            process.send(`Connect Error `)
            // walletSocketSevice.io.emit('api_connect_error');
        });

        this.socket.on('newBlock', (block) => {
            // process.send({ block });
            walletSocketSevice.currentSocket.emit('newBlock-api', block)
        })
    }
    
    private handleFromApiToWallet(eventName: string) {
        this.socket.on(eventName, (data: any) => walletSocketSevice.currentSocket.emit(eventName, data));
    }
}
