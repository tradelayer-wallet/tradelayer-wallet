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
        // const socketScript = new SocketScript();
        // const rpcConenctionOptions = {
        //     user: 'user',
        //     pass: 'passwrod',
        // };
        // socketScript.connect(rpcConenctionOptions).then((isConnected: boolean) => {
        //     if (!isConnected) return;
        //     socketScript.initListener({
        //         address: 'ms51vD4rsaR3m7ueN1d1wyFFTHXBEJL8Cr',
        //         logs: true,
        //     });
        // });
    }
}

const port: number = 6654;
const serverOptions: FastifyServerOptions = {};
const myServer = new FastifyServer(port, serverOptions);
myServer.start();
myServer.initSocketScript();