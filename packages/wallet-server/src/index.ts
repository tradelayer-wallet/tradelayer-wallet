import { FastifyServer } from './fastify-server';

export let fasitfyServer: FastifyServer;

export const initLoclaServer = (safeClose: () => void, authToken: string) => {
    const options = { logger: false };
    const port = 1986;
    fasitfyServer = new FastifyServer(port, options, safeClose, authToken);
    return fasitfyServer;
};

export default { fasitfyServer, initLoclaServer }