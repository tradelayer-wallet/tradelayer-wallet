import { FastifyInstance } from "fastify";
import { fasitfyServer } from "../index";
import { startWalletNode } from "../services/node.service";

export const mainRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.post('rpc-call', async (request, reply) => {
        try {
            const { method, params } = request.body as { method: string, params: any[] };
            if (!fasitfyServer.rpcClient) throw new Error("No RPC Client initialized");
            const _params = params?.length ? params : [];
            const res = await fasitfyServer.rpcClient.call(method, ..._params);
            process.send({res});

            reply.status(200).send(res);
        } catch (error) {
            reply.status(500).send({ error: error || 'Undefined Error' })
        }
    });

    fastify.post('start-wallet-node', async (request, reply) => {
        try {
            const { network, startclean, reindex, path } = request.body as {
                network: string;
                startclean: boolean;
                reindex: boolean;
                path: string;
            };
            const _isTestNetBool = network.endsWith('TEST');
            const walletNodeOptions = {
                testnet: _isTestNetBool,
                datadir: path,
                reindex,
                startclean,
            };
            const result = await startWalletNode(walletNodeOptions);
            reply.status(200).send(result);
        } catch (error) {
            reply.status(500).send({ error: error.message || 'Undefined Error' })
        }
    });
    done();
}