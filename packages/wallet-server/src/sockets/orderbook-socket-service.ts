import { io, Socket as SocketClient } from 'socket.io-client';
import { clearOrderBookService, myVersions, walletSocketSevice } from '.';
import { SocketScript } from '../socket-script/socket-script';

export class OrderbookSocketService {
    public socket: SocketClient;
    public isTestnet: boolean;
    constructor(private socketScript: SocketScript, host: string) {
        // this.isTestnet = isTestnet;
        // const url = isTestnet
        //     ? "http://ec2-13-40-194-140.eu-west-2.compute.amazonaws.com"
        //     : "http://170.187.147.182";
        // const host = `${url}:75`;
        this.socket = io(host, { reconnection: false });
        this.handleEvents();
    }

    terminate() {
        clearOrderBookService();
        this.socket.disconnect();
        this.socket = null;
    }
    private handleEvents() {
        this.socket.on('connect', () => {
            // this.socket.emit('check-versions', myVersions);
            walletSocketSevice.io.emit('server_connect')
        });

        // this.socket.on('version-guard', (valid: boolean) => {
        //     valid
        //         ? walletSocketSevice.io.emit('server_connect')
        //         : walletSocketSevice.io.emit('need-update');
        // });

        this.socket.on('disconnect', () => {
            walletSocketSevice.io.emit('server_disconnect');
        });

        this.socket.on('connect_error', () => {
            walletSocketSevice.io.emit('server_connect_error');
        });

        this.handleFromServerToWallet('trade:error');
        this.handleFromServerToWallet('trade:saved');
        this.handleFromServerToWallet('trade:completed');

        this.handleFromServerToWallet('error_message');
        this.handleFromServerToWallet('opened-positions');
        this.handleFromServerToWallet('orderbook-data');
        this.handleFromServerToWallet('aksfor-orderbook-update');
        this.handleFromServerToWallet('trade-history');

        this.handleFromServerToWallet('aksfor-orderbook-update-futures');
        this.handleFromServerToWallet('trade-history-futures');
        this.handleFromServerToWallet('orderbook-data-futures');
        this.handleFromServerToWallet('opened-positions-futures');

        this.socket.on('new-channel', async (trade: any) => {
            const res = await this.socketScript.channelSwap(this.socket, trade);
            res.error || !res.data
                ? walletSocketSevice.io.emit('trade:error', res.error)
                : walletSocketSevice.io.emit('trade:success', { data: res.data, trade });

            if (trade.filled && (trade?.secondSocketId === this.socket.id)) walletSocketSevice.io.emit('trade:completed', true);
        });
    }
    
    private handleFromServerToWallet(eventName: string) {
        this.socket.on(eventName, (data: any) => walletSocketSevice.currentSocket.emit(eventName, data));
    }
}
