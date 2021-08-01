import { throws } from "assert";
import { FastifyInstance } from "fastify"
import { Socket, Server } from "socket.io";
import { io, Socket as SocketClient } from 'socket.io-client';
import { SocketScript } from '../socket-script/socket-script';
export let walletSocketSevice: WalletSocketSevice;
export let serverSocketService: ServerSocketService;

export const initWalletConnection = (app: FastifyInstance, socketScript: SocketScript) => {
    walletSocketSevice = new WalletSocketSevice(app, socketScript);
};

export const initServerConnection = (socketScript: SocketScript) => {
    serverSocketService = new ServerSocketService(socketScript);
}

class WalletSocketSevice {
    public io: Server;
    public currentSocket: Socket;
    private socketScript: SocketScript;
    private lastBlock: number = 0;

    constructor(app: FastifyInstance, socketScript: SocketScript) {
        const socketOptions = { cors: { origin: "*", methods: ["GET", "POST"] } };
        this.io = new Server(app.server, socketOptions);
        this.socketScript = socketScript;
        this.handleEvents()
    }

    private handleEvents() {
        this.io.on('connection', this.onConnection.bind(this));
    }

    private onConnection(socket: Socket) {
        console.log(`FE app Connected`);
        this.currentSocket = socket;
        initServerConnection(this.socketScript);
        this.startBlockCounting(socket);
        this.handleFromWalletToServer(socket, 'orderbook-market-filter');
        this.handleFromWalletToServer(socket, 'update-orderbook');
        this.handleFromWalletToServer(socket, 'dealer-data');
        this.handleFromWalletToServer(socket, 'close-position');

        socket.on('api-recoonect', () => initServerConnection(this.socketScript));
    }

    private handleFromWalletToServer(socket: Socket, eventName: string) {
        socket.on(eventName, (data: any) => serverSocketService.socket.emit(eventName, data));
    }

    private startBlockCounting(socket: Socket) {
            setInterval(async () => {
                const { asyncClient } = this.socketScript;
                if (!asyncClient) return;
                const bbhRes = await asyncClient('getbestblockhash');
                if (bbhRes.error || !bbhRes.data) return null;
                const bbRes = await asyncClient('getblock', bbhRes.data);
                if (bbRes.error || !bbRes.data?.height) return null;
                const height = bbRes.data.height;

                if (this.lastBlock < height) {
                    this.lastBlock = height;
                    socket.emit('newBlock', height);
                    console.log(`New Block: ${height}`)
                }
            }, 5000);
    }
}

class ServerSocketService {
    public socket: SocketClient;
    constructor(private socketScript: SocketScript) {
        const host = 'http://66.228.57.16:76'
        this.socket = io(host, { reconnection: false });
        this.handleEvents();
    }

    private handleEvents() {
        this.socket.on('connect', () => {
            console.log(`Connected to the API Server`);
            walletSocketSevice.io.emit('server_connect');
        });

        this.socket.on('disconnect', () => {
            console.log(`Disconnected from the API Server`);
            walletSocketSevice.io.emit('server_disconnect');
        });

        this.socket.on('connect_error', () => {
            console.log(`API Server Connection Error`);
            walletSocketSevice.io.emit('server_connect_error');
        });

        this.handleFromServerToWallet('trade:error');
        this.handleFromServerToWallet('trade:saved');
        this.handleFromServerToWallet('trade:completed');

        this.handleFromServerToWallet('error_message');
        this.handleFromServerToWallet('opened-positions');
        this.handleFromServerToWallet('orderbook-data');
        this.handleFromServerToWallet('aksfor-orderbook-update');

        this.socket.on('new-channel', async (trade: any) => {
            const res = await this.socketScript.channelSwap(this.socket, trade);
            if (trade.filled && trade.buyer) walletSocketSevice.io.emit('trade:completed', true);
            if (res.error || !res.data) {
                walletSocketSevice.io.emit('trade:error', res.error);
            } else {
                walletSocketSevice.io.emit('trade:success', res.data);
            }

        });
    }
    
    private handleFromServerToWallet(eventName: string) {
        this.socket.on(eventName, (data: any) => walletSocketSevice.currentSocket.emit(eventName, data));
    }
}