import { FastifyInstance } from "fastify"
import SocketScript from "../socket-script";
import { orderbookSocketService, walletSocketSevice } from '../sockets';
import axios from 'axios';
import { INodeConfig, myWalletNode } from "../services/wallet-node";
import { RawTx } from "../socket-script/common/rawtx";
import { fasitfyServer } from '../../src/index';
import { buildAndSend } from '../services/txs';

export const socketRoutes = (socketScript: SocketScript) => {
    return (fastify: FastifyInstance, opts: any, done: any) => {

        fastify.get('/rpcCall', (request, reply) => {
        });

        fastify.post('/rpcCall/:method', async (request, reply) => {
            try {
                const { method } =  request.params as { method: string };
                const params = request.body;
                const res = await buildAndSend(socketScript, method, params);
                reply.send(res);    
            } catch (err) {
                reply.send({ error: err.message || `Error with buling the transction`});
            }
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

        fastify.get('/initTrade', (request, reply) => {
            try {
                const { trade, keyPair } = request.query as { trade: string, keyPair: string };
                const tradeObj = JSON.parse(trade);
                const keyPairObj = JSON.parse(keyPair);
                const { address, pubKey } = keyPairObj;
                orderbookSocketService.socket.emit('init-trade', {...tradeObj, address, pubKey});
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
                orderbookSocketService.socket.emit('init-trade', { ...trade, address, pubKey });
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
                orderbookSocketService.socket.emit('close-position', order);
                reply.send({data: 'Sent'});
            } catch(error) {
                reply.send({ error: error.message });
            }
        });

        fastify.get('/ordersList', async (request, reply) => {
            try {
                const id = orderbookSocketService.socket.id;
                const host = orderbookSocketService.isTestnet
                    ? "http://ec2-13-40-194-140.eu-west-2.compute.amazonaws.com"
                    : "http://66.228.57.16";
                const res = await axios.get(`${host}:3002/trade/ordersList?id=${id}`);
                if (res.data) return reply.send(res.data);
                reply.send({ error: `Undefined Error`});
            } catch(error) {
                reply.send({ error: error.message });
            }
        });

        fastify.get('/startWalletNode', async (request, reply) => {
            try {
                const { directory, isTestNet, reindex, startclean, startWithOffline } = request.query as { 
                    directory: string, 
                    isTestNet: string, 
                    reindex: string,
                    startclean: string, 
                    startWithOffline: string,
                };
                const _isTestNetBool = isTestNet === 'true';
                const isReindex = reindex === 'true';
                const isStartclean = startclean === 'true';

                const isStartWithOffline = startWithOffline === 'true';

                const walletNodeOptions = {
                    testnet: _isTestNetBool,
                    datadir: directory,
                    reindex: isReindex,
                    startclean: isStartclean,
                };

                const res = await myWalletNode.startWalletNode(walletNodeOptions, isStartWithOffline);
                reply.send(res);
            } catch (error) {
                reply.send({ error: error.message });
            }
        });

        fastify.get('/createNewNode', async (request, reply) => {
            try {
                const { username, password, port, path } = request.query as INodeConfig;
                const newNodeConfig = { username, password, port, path };
                const res = myWalletNode.createNodeConfig(newNodeConfig);
                reply.send(res);
            } catch (error) {
                reply.send({ error: error.message });
            }
        });

        fastify.post('/buildTx', async (request, reply) => {
            try {
                const res = await txBuilder(request.body);
                res.error || !res.data
                    ? reply.send({ error: res.error })
                    : reply.send({ data: res.data});
            } catch (error) {
                reply.send({ error: error.message });
            }
        });

        fastify.get('/saveConfigFile', (request, reply) => {
            try {
                const { isTestNet } = request.query as { isTestNet: string };
                const _isTestNetBool = isTestNet === 'true';
                const res = myWalletNode.createWalletconfig(_isTestNetBool);
                reply.send(res);
            } catch(error) {
                reply.send({ error: error.message });
            }
        });

        // fastify.get('/extractKeyPairFromPrivKey', (request, reply) => {
        //     try {
        //         // const { privKey } = request.query as { privKey: string };
        //         // const privateKeyObj = litecoreLib.PrivateKey.getValidationError(privKey, litecoreLib.testnet);

        //         // const data = {
        //         //     privateKeyObj: privateKeyObj.toPublicKey().toAddress(litecoreLib.Networks.testnet).toString(),
        //         //     completed: true,
        //         // };
        //         reply.send({ data: false });
        //     } catch(error) {
        //         reply.send({ error: error.message });
        //     }
        // });

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

        fastify.get('/terminate', async (request, reply) => {
            try {
                walletSocketSevice.stopBlockCounting();
                walletSocketSevice.lastBlock = 0;
                orderbookSocketService.terminate();
                fasitfyServer.socketScript.asyncClient = null;
                await fasitfyServer.stop('Terminate From Wallet!');
                reply.send({ data: true });
            } catch(error) {
                reply.send({ error: error.message });
            }
        });

        fastify.post('/runLiquidityScript', async (request, reply) => {
            try {
                const options = request.body;
                const res = await fasitfyServer.socketScript.runLiquidityScript(options);
                reply.send(res);
            } catch (err) {
                reply.send({ error: err.message });
            }
        });

        fastify.post('/stopLiquidityScript', async (request, reply) => {
            try {
                const { address } = request.body as { address: string };
                if (!address) return reply.send({ error: `No Address Provided!`});
                const res = await fasitfyServer.socketScript.stopLiquidityScript(address);
                reply.send(res);
            } catch (err) {
                reply.send({ error: err.message });
            }
        });

        done();
    }
};

const txBuilder = async (options: any) => {
    const client = fasitfyServer.socketScript.asyncClient;
    const { txType, fromAddress, toAddress, amount, inputs, featureid, block, minclientversion, propId } = options;
    switch (txType) {
        case 'SEND_LTC':
            const sLtcRawTx = new RawTx({
                fromAddress,
                toAddress,
                refAddressAmount: parseFloat(amount),
                inputs: inputs ? JSON.parse(inputs) : [],
            }, client);
            const sLtcBuildHex = await sLtcRawTx.build();
            return sLtcBuildHex.error || !sLtcBuildHex.data
                ? { error: sLtcBuildHex.error ||`Error with building the transaction` }
                : { data: sLtcBuildHex.data };

        case 'SEND_VESTING':
            const svPayloadRes = await client('tl_createpayload_sendvesting', amount.toString());
            if (svPayloadRes.error || !svPayloadRes.data) return{ error: svPayloadRes.error };
            const svRawTx = new RawTx({ 
                fromAddress, 
                toAddress, 
                payload: svPayloadRes.data, 
                inputs: inputs ? JSON.parse(inputs) : [],
            }, client);
            const svBuildHex = await svRawTx.build();
            return svBuildHex.error || !svBuildHex.data
                ? { error: svBuildHex.error }
                : { data: svBuildHex.data };
    
        case 'SEND_TOKEN':
            const stPayloadRes = await client('tl_createpayload_simplesend', parseInt(propId), amount.toString());
            if (stPayloadRes.error || !stPayloadRes.data) return { error: stPayloadRes.error };
            const stRawTx = new RawTx({ 
                fromAddress,
                toAddress,
                payload: stPayloadRes.data,
                inputs: inputs ? JSON.parse(inputs) : [],
            }, client);
            const stBuildHex = await stRawTx.build();
            return stBuildHex.error || !stBuildHex.data
                ? { error: stBuildHex.error }
                : { data: stBuildHex.data };

        case 'SEND_ACTIVATION':
            const saPayloadRes = await client(
                    'tl_createpayload_sendactivation',
                    parseInt(featureid),
                    parseInt(block),
                    parseInt(minclientversion),
                );
            if (saPayloadRes.error || !saPayloadRes.data) return { error: saPayloadRes.error };
            const saRawTx = new RawTx({ 
                fromAddress,
                toAddress,
                payload: saPayloadRes.data,
                inputs: inputs ? JSON.parse(inputs) : [],
            }, client);
            const saBuildHex = await saRawTx.build();
            return saBuildHex.error || !saBuildHex.data
                ? { error: saBuildHex.error }
                : { data: saBuildHex.data };
        default:
            return { error: 'Unsuported TX Type' };
    }
}