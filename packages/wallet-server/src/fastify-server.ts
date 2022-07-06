import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { handleRoutes } from './routes';
import { SocketService } from './services/socket.service';

export class FastifyServer {
    private _server: FastifyInstance;
    private mainSocketService: SocketService;

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
            .catch((error) => this.stop(error.message));
    }

    async stop(message: string) {
        process.send(`STOP`);
    }
}
