import { FastifyServer } from './fastify-server';

let fasitfyServer: FastifyServer;

process.on('message', (message) => {
    console.log({message});
    switch (message) {
        case 'init':
            const options = { logger : true };
            const port = 1986;
            fasitfyServer = new FastifyServer(port, options);
            break;
        case 'start':
            fasitfyServer.start();
            break;
        case 'stop':
            fasitfyServer.stop('App closed');
        default:
            break;
    }
});
