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

    public relayerApiUrl: "LTC" | "LTCTEST" | null = null;

    constructor(
        private port: number, 
        options: FastifyServerOptions,
        private safeClose: () => void,
    ) {
        this._server = Fastify(options);
        this.mainSocketService = new SocketService();
    }

    get server() {
        return this._server
    }

    start() {
        handleRoutes(this.server);
        this.mainSocketService.init(this.server);
        this.server.listen(this.port)
            .catch((error) => this.stop());
    }

    async stop() {
        if (this.rpcClient) {
            const isConnectedRes = await this.rpcClient.call('tl_getinfo');
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
