import { FastifyInstance } from "fastify";
import { Socket, Server } from "socket.io";
import { fasitfyServer } from "..";

export class SocketService {
    private blockCountingInterval: any;
    private lastBlock: number = 0;
    private lastHeader: number = 0;
    private _obConnectHandler?: (url: string) => void;
    private _wiredSocketForOb?: any;


    public io: Server;
    public currentSocket: Socket;

    constructor() {}

    init(app: FastifyInstance) {
        const socketOptions = { cors: { origin: "*", methods: ["GET", "POST"] } };
        this.io = new Server(app.server, socketOptions);
        this.io.use((socket, next) => {
            const expectedToken = String(process.env.TL_LOCAL_API_TOKEN || '').trim();
            if (!expectedToken) {
                next();
                return;
            }

            const authToken = String(socket.handshake.auth?.token || '').trim();
            const queryToken = String(socket.handshake.query?.tl_auth || '').trim();
            const providedToken = authToken || queryToken;
            if (providedToken === expectedToken) {
                next();
                return;
            }

            next(new Error('Unauthorized local socket connection'));
        });
        this.handleEvents()
    }

    private handleEvents() {
        this.io.on('connection', this.onConnection.bind(this));
    }

    private onConnection(socket: Socket) {
      // Clean up the previous socket
      if (this.currentSocket) {
        this.currentSocket.removeAllListeners?.('ob-sockets-connect');
        this.currentSocket.removeAllListeners?.('ob-sockets-disconnect');
        this.currentSocket.offAny?.();
      }

      // Swap to the new socket
      this.currentSocket = socket;

      // Defensive: ensure the new socket has no stale handlers
      this.currentSocket.removeAllListeners?.('ob-sockets-connect');
      this.currentSocket.removeAllListeners?.('ob-sockets-disconnect');

      // Wire fresh handlers exactly once
      this.currentSocket.on('ob-sockets-connect', (url: string) => {
        fasitfyServer.initOBSocketConnection({ url });
      });

      this.currentSocket.on('ob-sockets-disconnect', () => {
        fasitfyServer.clearOBSocketConnection();
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
