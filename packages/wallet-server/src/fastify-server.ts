import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { handleRoutes } from './routes';
import { SocketService } from './services/socket.service';
import { RpcClient } from 'tl-rpc';
import * as killPort from 'kill-port';
import { ChildProcess } from 'child_process';

export class FastifyServer {
    private _server: FastifyInstance;
    public rpcClient: RpcClient;
    public rpcPort: number;
    public mainSocketService: SocketService;

    constructor(
        private port: number, 
        options: FastifyServerOptions,
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

    private async safeStop() {
        if (this.rpcClient || this.rpcPort) return;
        process.emit("exit", 1);
        process.exit(1);
    }
}
