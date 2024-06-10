import { FastifyInstance } from "fastify";
import { Socket, Server } from "socket.io";
import { fasitfyServer } from "..";

export class SocketService {
    private blockCountingInterval: any;
    private lastBlock: number = 0;
    private lastHeader: number = 0;

    public io: Server;
    public currentSocket: Socket;

    constructor() {}

    init(app: FastifyInstance) {
        const socketOptions = { cors: { origin: "*", methods: ["GET", "POST"] } };
        this.io = new Server(app.server, socketOptions);
        this.handleEvents()
    }

    private handleEvents() {
        this.io.on('connection', this.onConnection.bind(this));
    }

    private onConnection(socket: Socket) {
        if (this.currentSocket) this.currentSocket.offAny();
        this.currentSocket = socket;
    
        this.currentSocket.on('ob-sockets-connect', (url: string) => {
            fasitfyServer.initOBSocketConnection({ url });
        });

        this.currentSocket.on('ob-sockets-disconnect', () => {
            // fasitfyServer.clearOBSocketConnection();
        });
    }

    startBlockCounting(ms: number) {
        if (this.blockCountingInterval) this.stopBlockCounting();
        const client = fasitfyServer.rpcClient;
        if (!client) return;
        this.blockCountingInterval = setInterval(async () => {
            const infoRes = await client.call('getblockchaininfo');
            if (infoRes.error || !infoRes.data) {
                if (infoRes.error && infoRes.error.includes('ECONNREFUSED')) {
                    const check = await client.call('getblockchaininfo');
                    if (check.error || !check.data) {
                        this.currentSocket.emit("core-error", check.error || 'Undefined Error. code 3')
                        this.stopBlockCounting();
                    }
                }
            }
            const height = infoRes?.data?.blocks;
            const header = infoRes?.data?.headers;
            if ((height && this.lastBlock < height) || (header && this.lastHeader < header)) {
                this.lastBlock = height;
                this.lastHeader = header;
                this.currentSocket.emit('new-block', { height, header });
            }
        }, ms);
    }

    stopBlockCounting() {
        if (this.lastBlock) this.lastBlock = 0;
        if (this.blockCountingInterval) clearInterval(this.blockCountingInterval);
    }
}