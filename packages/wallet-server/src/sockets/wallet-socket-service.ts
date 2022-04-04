import { Socket, Server } from "socket.io";
import { SocketScript } from '../socket-script/socket-script';
import { FastifyInstance } from "fastify"
import { disconnectFromOrderbook, initApiService, initOrderbookConnection, orderbookSocketService } from ".";

interface IContractInfo {
    contractName: string;
    contractId: number;
}

export class WalletSocketSevice {
    public io: Server;
    public currentSocket: Socket;
    private socketScript: SocketScript;
    public lastBlock: number = 0;
    private blockCountingInterval: any;

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
        if (this.currentSocket) this.currentSocket.offAny()
        this.currentSocket = socket;

        ['update-orderbook', 'new-order']
            .forEach(m => this.handleFromWalletToServer(m));

        socket.on('orderbook-server-reconnect', (url: string) => initOrderbookConnection(this.socketScript, url));
        socket.on('orderbook-server-disconnect', () => disconnectFromOrderbook());
        socket.on('api-server-reconnect', (isTestNet: boolean) => initApiService(isTestNet));
    }

    private handleFromWalletToServer(eventName: string) {
        this.currentSocket.on(eventName, (data: any) => orderbookSocketService.socket.emit(eventName, data));
    }

    stopBlockCounting() {
        if (this.blockCountingInterval) {
            clearInterval(this.blockCountingInterval);
            this.blockCountingInterval = null;
        }
    }

    startBlockCounting() {
        if (this.blockCountingInterval) return;
        this.blockCountingInterval = setInterval(async () => {
            const { asyncClient } = this.socketScript;
            if (!asyncClient) return;
            const bbhRes = await asyncClient('getbestblockhash');
            if (bbhRes.error || !bbhRes.data) {
                this.onTimeOutMessage(bbhRes.error);
                return null;
            }
            const bbRes = await asyncClient('getblock', bbhRes.data);
            if (bbRes.error || !bbRes.data) {
                this.onTimeOutMessage(bbhRes.error);
                return null;
            };
            const height = bbRes.data.height;
            if (this.lastBlock < height) {
                this.lastBlock = height;
                this.currentSocket.emit('newBlock', height);
            }
        }, 2500);
    }

    async onTimeOutMessage(message: string) {
        if (message && message.includes('ECONNREFUSED')) {
            const { asyncClient } = this.socketScript;
            const check = await asyncClient('tl_getinfo');
            if (check.error || !check.data) {
                this.currentSocket.emit('rpc-connection-error');
                this.socketScript.clearConnection();
            }
        }
    }
}
