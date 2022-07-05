import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { handleRoutes } from './routes';

export class FastifyServer {
    private _server: FastifyInstance;
    constructor(
        private port: number, 
        options: FastifyServerOptions,
    ) {
        this._server = Fastify(options);
    }

    get server() {
        return this._server
    }

    start() {
        handleRoutes(this.server);
        this.server.listen(this.port)
            .catch((error) => this.stop(error.message));
    }

    async stop(message: string) {
        process.send(`STOP`);
    }
}
