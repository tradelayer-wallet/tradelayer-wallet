import { FastifyInstance } from "fastify"

export const socketRoutes = (socketScript: any) => {
    return (fastify: FastifyInstance, opts: any, done: any) => {
        fastify.get('/connect', (request, reply) => {
            const { user, pass } = request.query as { user: string, pass: string};
            if (!user || !pass ) {
                reply.send(false);
                return;
            };
            socketScript.connect({ user, pass })
                .then((isConnected: boolean) => {
                    reply.send(isConnected);
                });
        });
    
        fastify.get('/listStart', (request, reply) => {
            console.log("listStart!");
            const { address } = request.query as { address: string };
            if (!address) {
                reply.send(false);
                return;
            }
            socketScript.startListener({address, logs: true});
        });
    
        fastify.get('/listStop', () => {
            console.log("listStop!");
            socketScript.stopListener();
        });
    
        fastify.get('/initLTCInstantTrade', () => {
            console.log("initLTCInstantTrade!");
        });

        fastify.get('/initTokenTokenTrdae', () => {
            console.log("initTokenTokenTrdae!");
        });

        done();
    }
};