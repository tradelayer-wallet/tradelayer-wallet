import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { handleRoutes } from './routes';
import { RpcClient } from 'tl-rpc';
import { SocketService } from './services/socket.service';
import { IOBSocketServiceOptions, OBSocketService } from './services/ob-sockets.service';
import * as killPort from 'kill-port';

export class FastifyServer {
    private _server: FastifyInstance;
    public rpcClient: RpcClient;
    public rpcPort: number;
    public mainSocketService: SocketService;
    public obSocketService: OBSocketService;

    public relayerApiUrl: string | null = null;

    constructor(
        private port: number, 
        options: FastifyServerOptions,
        private safeClose: () => void,
    ) {
        this._server = Fastify(options);
        // Mitigate DNS-rebinding attacks: the routes below are unauthenticated
        // and proxy node RPC / transaction signing, so reject any request whose
        // Host header is not loopback. Without this, a malicious website can
        // resolve its own domain to 127.0.0.1 and read responses from this API.
        this._server.addHook('onRequest', (request, reply, next) => {
            const host = (request.headers.host || '').split(':')[0];
            if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') {
                reply.status(403).send({ error: 'Forbidden Host header' });
                return;
            }
            next();
        });
        this.mainSocketService = new SocketService();
    }

    get server() {
        return this._server
    }

    start() {
        handleRoutes(this.server);
        this.mainSocketService.init(this.server);
        // Bind to loopback only. Fastify v3 defaults to 0.0.0.0 when no host
        // is given, which exposed this unauthenticated signing/RPC API to the
        // entire local network.
        this.server.listen(this.port, '127.0.0.1')
            .catch((error) => this.stop());
    }

    async stop() {
        if (this.rpcClient) {
            const isConnectedRes = await this.rpcClient.call('getblockchaininfo');
            const isConnected = !!isConnectedRes.data;
            if (isConnected) await this.rpcClient.call('stop');
            if (!isConnected) await killPort(this.rpcPort);
        }

        this.safeStop();
        const safeExistInterval = setInterval(() => {
            if (this.rpcClient || this.rpcPort) return;
            clearInterval(safeExistInterval);
            this.safeStop();
        }, 500);
    }

    private safeStop() {
        if (this.rpcClient || this.rpcPort) return;
        this.clearOBSocketConnection();
        this.safeClose();
        this.clearMainSocketConnection();
    }

    initOBSocketConnection(options: IOBSocketServiceOptions) {
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
