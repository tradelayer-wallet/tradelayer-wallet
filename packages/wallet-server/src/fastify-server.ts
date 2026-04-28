import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { handleRoutes } from './routes';
import { RpcClient } from 'tl-rpc';
import { SocketService } from './services/socket.service';
import { IOBSocketServiceOptions, OBSocketService } from './services/ob-sockets.service';
import killPort from 'kill-port';
import { TradeLayerService } from './services/tradelayer.service';

const LOCAL_AUTH_QUERY_KEY = 'tl_auth';

export class FastifyServer {
    private _server: FastifyInstance;
    public rpcClient: RpcClient;
    public rpcPort: number;
    public mainSocketService: SocketService;
    public obSocketService: OBSocketService;
    public tradelayerService: TradeLayerService;
    public relayerApiUrl: string | null = null;
    private started = false;
    private stopping = false;

    constructor(
        private port: number, 
        options: FastifyServerOptions,
        private safeClose: () => void,
    ) {
        this._server = Fastify(options);
        this.mainSocketService = new SocketService();
        this.tradelayerService = new TradeLayerService();
    }

    get server() {
        return this._server
    }

    private get localApiToken() {
        return String(process.env.TL_LOCAL_API_TOKEN || '').trim();
    }

    private registerLocalAuthHook() {
        this.server.addHook('preValidation', async (request, reply) => {
            const expectedToken = this.localApiToken;
            if (!expectedToken) {
                return;
            }

            const headerToken = String(request.headers['x-tradelayer-local-auth'] || '').trim();
            const authHeader = String(request.headers.authorization || '').trim();
            const bearerToken = authHeader.startsWith('Bearer ')
                ? authHeader.slice('Bearer '.length).trim()
                : '';
            const queryToken = String((request.query as any)?.[LOCAL_AUTH_QUERY_KEY] || '').trim();
            const providedToken = headerToken || bearerToken || queryToken;

            if (providedToken === expectedToken) {
                return;
            }

            reply.code(401).send({ error: 'Unauthorized local API request' });
        });
    }

    start() {
        if (this.started) {
            return;
        }
        this.started = true;
        this.registerLocalAuthHook();
        handleRoutes(this.server);
        this.mainSocketService.init(this.server);
        const host = process.env.WALLET_API_HOST || '127.0.0.1';
        this.server.listen(this.port, host)
            .catch((error) => this.stop());
    }

    async stop() {
        if (this.stopping) {
            return;
        }
        this.stopping = true;

        try {
            if (this.rpcClient) {
                const withTimeout = async (promise: Promise<any>, ms: number) => {
                    let timeout: any;
                    const timeoutPromise = new Promise((_, reject) => {
                        timeout = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
                    });
                    try {
                        return await Promise.race([promise, timeoutPromise]);
                    } finally {
                        clearTimeout(timeout);
                    }
                };

                const isConnectedRes: any = await withTimeout(this.rpcClient.call('getblockchaininfo'), 1500)
                    .catch(() => ({ data: null }));
                const isConnected = !!isConnectedRes?.data;
                await withTimeout(this.tradelayerService.stop(), 1500).catch(() => null);
                if (isConnected) {
                    await withTimeout(this.rpcClient.call('stop'), 1500).catch(() => null);
                } else if (this.rpcPort) {
                    await withTimeout(killPort(this.rpcPort), 1500).catch(() => null);
                }
            }
        } finally {
            this.rpcClient = null;
            this.rpcPort = null;
            try {
                await this.server.close();
            } catch (_) {}
            this.started = false;
            this.stopping = false;
            this.safeStop();
        }
    }

    private safeStop() {
        if (this.rpcClient || this.rpcPort) return;
        this.clearOBSocketConnection();
        this.safeClose();
        this.clearMainSocketConnection();
    }

    initOBSocketConnection(options: IOBSocketServiceOptions){
        console.log('initializing ob socket')
        this.clearOBSocketConnection();
        this.obSocketService = new OBSocketService(options);
    }


    clearMainSocketConnection() {
        if (this.mainSocketService?.currentSocket) {
            this.mainSocketService?.currentSocket.offAny();
            this.mainSocketService?.currentSocket.disconnect();
        }
        this.mainSocketService = null;
    }

    clearOBSocketConnection() {
        if (this.obSocketService?.socket) {
            this.obSocketService.socket.offAny();
            this.obSocketService.socket.disconnect();
        }
        this.obSocketService = null;
    }
}
