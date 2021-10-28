import { FastifyInstance } from "fastify"
import SocketScript from "../socket-script";
import { serverSocketService } from '../sockets';
import { startWalletNode, createNewNode, createTLconfigFile } from '../services/wallet-node';
import axios from 'axios';

export const socketRoutes = (socketScript: SocketScript) => {
    return (fastify: FastifyInstance, opts: any, done: any) => {

        fastify.get('/rpcCall', (request, reply) => {
            console.log(request.query);
        });

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
    
        // fastify.get('/listStart', (request, reply) => {
        //     const { address } = request.query as { address: string };
        //     if (!address) {
        //         reply.send(false);
        //         return;
        //     }
        //     // socketScript.startListener({address, logs: true});
        // });
    
        // fastify.get('/listStop', () => {
        //     // socketScript.stopListener();
        // });
    
        fastify.get('/initTrade', (request, reply) => {
            try {
                const { trade, keyPair } = request.query as { trade: string, keyPair: string };
                const tradeObj = JSON.parse(trade);
                const keyPairObj = JSON.parse(keyPair);
                const { address, pubKey } = keyPairObj;
                serverSocketService.socket.emit('init-trade', {...tradeObj, address, pubKey});
                reply.send({data: 'Sent'});
            } catch(error) {
                reply.send({ error: error.message });
            }
        });

        fastify.post('/initTrade', (request, reply) => {
            try {
                const { trade, keyPair } = request.body as { trade: any, keyPair: any };
                if (!trade || !keyPair?.address || !keyPair?.pubKey) {
                    reply.send({ error: 'Missing Data' });
                    return;
                }
                const { address, pubKey } = keyPair;
                serverSocketService.socket.emit('init-trade', { ...trade, address, pubKey });
                reply.send({data: 'Sent'});
            } catch(error) {
                reply.send({ error: error.message });
            }
        })

        fastify.post('/removeOrder', (request, reply) => {
            try {
                const { order } = request.body as { order: any };
                if (!order) {
                    reply.send({ error: 'Missing Data' });
                    return;
                }
                serverSocketService.socket.emit('close-position', order);
                reply.send({data: 'Sent'});
            } catch(error) {
                reply.send({ error: error.message });
            }
        });

        fastify.get('/ordersList', async (request, reply) => {
            try {
                const id = serverSocketService.socket.id;
                const port = serverSocketService.isTestnet ? '3006' : '3002';
                const res = await axios.get(`http://66.228.57.16:${port}/trade/ordersList?id=${id}`);
                if (res.data) return reply.send(res.data);
                reply.send({ error: `Undefined Error`});
            } catch(error) {
                reply.send({ error: error.message });
            }
        });

        fastify.get('/startWalletNode', async (request, reply) => {
            try {
                const { directory, isTestNet } = request.query as { directory: string, isTestNet: string };
                const _isTestNetBool = isTestNet === 'true';
                const res = await startWalletNode(directory, _isTestNetBool);
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

        fastify.get('/extractKeyPairFromPrivKey', (request, reply) => {
            try {
                // const { privKey } = request.query as { privKey: string };
                // const privateKeyObj = litecoreLib.PrivateKey.getValidationError(privKey, litecoreLib.testnet);

                // const data = {
                //     privateKeyObj: privateKeyObj.toPublicKey().toAddress(litecoreLib.Networks.testnet).toString(),
                //     completed: true,
                // };
                reply.send({ data: false });
            } catch(error) {
                reply.send({ error: error.message });
            }
        });

        fastify.get('/withdraw', async (request, reply) => {
            try {
                const { fromAddress, toAddress, amount } = request.query as { 
                    fromAddress: string,
                    toAddress: string,
                    amount: string,
                };
                const res = await socketScript.withdraw(fromAddress, toAddress, amount);
                if (res.error || !res.data) {
                    reply.send({ error: res.error || `Undefined Withdraw Error!` });
                    return;
                }
                reply.send({ data: res.data });
            } catch(error) {
                reply.send({ error: error.message });
            }
        });

        fastify.get('/saveConfigFile', (request, reply) => {
            try {
                const { isTestNet } = request.query as { isTestNet: string };
                const _isTestNetBool = isTestNet === 'true';
                const res = createTLconfigFile(_isTestNetBool);
                reply.send(res);
            } catch(error) {
                reply.send({ error: error.message });
            }
        });

        done();
    }
};