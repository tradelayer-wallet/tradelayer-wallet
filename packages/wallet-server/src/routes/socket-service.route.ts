import { FastifyInstance } from "fastify"
import SocketScript from "../socket-script";
import { serverSocketService } from '../sockets'
export const socketRoutes = (socketScript: SocketScript) => {
    return (fastify: FastifyInstance, opts: any, done: any) => {
        fastify.get('/connect', (request, reply) => {
            const { user, pass, port } = request.query as { user: string, pass: string, port: number};
            if (!user || !pass || !port) {
                reply.send(false);
                return;
            };
            socketScript.connect({ user, pass, port })
                .then((isConnected: boolean) => {
                    reply.send(isConnected);
                });
        });
    
        fastify.get('/listStart', (request, reply) => {
            const { address } = request.query as { address: string };
            if (!address) {
                reply.send(false);
                return;
            }
            // socketScript.startListener({address, logs: true});
        });
    
        fastify.get('/listStop', () => {
            // socketScript.stopListener();
        });
    
        fastify.get('/initTrade', (request, reply) => {
            const { trade, keyPair } = request.query as { trade: string, keyPair: string };
            try {
                const tradeObj = JSON.parse(trade);
                const keyPairObj = JSON.parse(keyPair);
                const { address, pubKey } = keyPairObj;
                serverSocketService.socket.emit('init-trade', {...tradeObj, address, pubKey});
                reply.send({data: 'Sent'});
            } catch(error) {
                reply.send({ error: error.message });
            }
        });

        done();
    }
};