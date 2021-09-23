import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
// todo: declare the type;
import SocketScript from './socket-script';
import { handleRoutes } from './routes';
import * as SocketsService from './sockets';
import * as killPort from 'kill-port';

export class FastifyServer {
    private _server: FastifyInstance;
    private _socketScript: SocketScript;

    nodePort: number;
    constructor(
        private port: number, 
        options: FastifyServerOptions,
    ) {
        this._server = Fastify(options);
    }

    get server() {
        return this._server
    }

    get socketScript() {
        return this._socketScript;
    }

    start() {
        this.initSocketScript();
        this.handleSockets();
        this.handleRoutes();
        this.server.listen(this.port)
            .catch((error) => this.stop(error.message));
    }

    async stop(message: string) {
        return new Promise(async (res) => {
            if (this.nodePort) {
                if (this.socketScript?.asyncClient) await this.socketScript.asyncClient('stop');
                await killPort(this.nodePort);
            }
            this.server.log.error(message);
            res(true);
        })
    }

    private handleRoutes() {
        handleRoutes(this.server, this.socketScript);
    }

    private handleSockets() {
        SocketsService.initWalletConnection(this.server, this.socketScript);
    }

    private initSocketScript() {
        this._socketScript = new SocketScript();
    }
}
