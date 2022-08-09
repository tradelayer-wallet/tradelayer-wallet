import { FastifyInstance } from "fastify";
import { Socket, Server } from "socket.io";
import { fasitfyServer } from "..";

export class SocketService {
    private blockCountingInterval: any;
    private lastBlock: number = 0;

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
    }

    startBlockCounting(ms: number) {
        if (this.blockCountingInterval) this.stopBlockCounting();
        const client = fasitfyServer.rpcClient;
        if (!client) return;
        this.blockCountingInterval = setInterval(async () => {
            const infoRes = await client.call('tl_getinfo');
            if (infoRes.error || !infoRes.data) {
                if (infoRes.error && infoRes.error.includes('ECONNREFUSED')) {
                    const check = await client.call('tl_getinfo');
                    if (check.error || !check.data) {
                        this.currentSocket.emit("core-error", check.error || 'Undefined Error. code 3')
                        this.stopBlockCounting();
                    }
                }
            }
            const height = infoRes?.data?.block;
            if (height && this.lastBlock < height) {
                this.lastBlock = height;
                this.currentSocket.emit('new-block', height);
            }
        }, ms);
    }

    stopBlockCounting() {
        if (this.lastBlock) this.lastBlock = 0;
        if (this.blockCountingInterval) clearInterval(this.blockCountingInterval);
    }
}