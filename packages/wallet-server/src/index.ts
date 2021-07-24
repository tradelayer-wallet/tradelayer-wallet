import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';

class FastifyServer {
    private server: FastifyInstance;
    constructor(
        private port: number, 
        options: FastifyServerOptions,
    ) {
        this.server = Fastify(options);
    }

     start() {
        this.server.listen(this.port)
            .then((address) => console.log(`Fastify Server Started: ${address}`))
            .catch((error) => this.stop(error.message));
    }

    stop(message: string) {
        console.log(message);
        process.exit(1);
    }

    initSocketScript() {
    }
}

const port: number = 6654;
const serverOptions: FastifyServerOptions = {};
const myServer = new FastifyServer(port, serverOptions);
myServer.start();