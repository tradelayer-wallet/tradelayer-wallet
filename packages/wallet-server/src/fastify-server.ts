import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
// todo: declare the type;
import SocketScript from './socket-script';
import { handleRoutes } from './routes';
import * as SocketsService from './sockets';

export class FastifyServer {
    private _server: FastifyInstance;
    private _socketScript: SocketScript;
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

    stop(message: string) {
        this.server.log.error(message);
        process.exit(1);
    }

    private handleRoutes() {
        handleRoutes(this.server, this.socketScript);
    }

    private handleSockets() {
        SocketsService.initServerConnection();
        SocketsService.initWalletConnection(this.server, this.socketScript);
    }

    private initSocketScript() {
        this._socketScript = new SocketScript();
    }
}
