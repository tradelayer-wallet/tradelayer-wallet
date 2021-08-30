import { FastifyInstance } from "fastify"
import SocketScript from "../socket-script";
import { serverSocketService } from '../sockets';
import { startWalletNode, createNewNode } from '../services/wallet-node';

export const socketRoutes = (socketScript: SocketScript) => {
    return (fastify: FastifyInstance, opts: any, done: any) => {

        fastify.get('/checkConnection', (request, reply) => {
            reply.send(true);
        });

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

        fastify.get('/startWalletNode', async (request, reply) => {
            try {
                const { directory } = request.query as { directory: string };
                const res = await startWalletNode(directory);
                reply.send(res);
            } catch (error) {
                reply.send({ error: error.message });
            }
        });

        fastify.get('/createNewNode', async (request, reply) => {
            try {
                const { username, password, port, path } = request.query as { 
                    username: string;
                    password: string;
                    port: number;
                    path: string;
                };
                const newNodeConfig = { username, password, port, path };
                const res = await createNewNode(newNodeConfig);
                reply.send(res);
            } catch (error) {
                reply.send({ error: error.message });
            }
        });
        done();
    }
};