import { FastifyServer } from './fastify-server';

export let fasitfyServer: FastifyServer;

process.on('message', async (message) => {
    switch (message) {
        case 'init':
            const options = { logger: false };
            const port = 1986;
            fasitfyServer = new FastifyServer(port, options);
            break;
        case 'start':
            fasitfyServer.start();
            break;
        case 'stop':
            await fasitfyServer.stop();
        default:
            break;
    }
});
