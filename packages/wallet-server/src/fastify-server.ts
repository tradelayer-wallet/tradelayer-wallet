import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
// todo: declare the type;
import SocketScript from './socket-script';
import { handleRoutes } from './routes';
import * as SocketsService from './sockets';
import * as killPort from 'kill-port';
import { EventEmitter } from 'stream';

export class FastifyServer {
    private _server: FastifyInstance;
    private _socketScript: SocketScript;
    private _eventEmitter: EventEmitter = new EventEmitter();

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

    get eventEmitter() {
        return this._eventEmitter;
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
                await new Promise(res2 => {
                    this.eventEmitter.on('killer', () => res2(true));
                    setTimeout(() => res2(true), 5000);
                });
                await killPort(this.nodePort);
                this.nodePort = null;
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
