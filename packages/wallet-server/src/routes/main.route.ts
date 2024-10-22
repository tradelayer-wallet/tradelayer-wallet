import { FastifyInstance } from "fastify";
import { fasitfyServer } from "../index";
import { startWalletNode, createConfigFile, stopWalletNode } from "../services/node.service";
import { buildLTCInstatTx, buildTx, IBuildLTCITTxConfig, IBuildTxConfig, ISignPsbtConfig, ISignTxConfig, signTx } from "../services/tx-builder.service";
import { signPsbtRawtTx } from "../utils/crypto.util";
import { backOff, BackoffOptions } from "exponential-backoff";
import { TradeLayerService } from '../services/tradelayer.service';  // Correctly import the named export

const tradeLayerService = new TradeLayerService();

const backoffOptions: BackoffOptions = {
    maxDelay: 10000,
    numOfAttempts: 5,
}

export const mainRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.post('rpc-call', async (request, reply) => {
        try {
            const { method, params } = request.body as { method: string, params: any[] };
            if (!fasitfyServer.rpcClient) throw new Error("No RPC Client initialized");
            const _params = params?.length ? params : [];
            const res = await backOff(() => fasitfyServer.rpcClient.call(method, ..._params), backoffOptions);
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

    fastify.post('stop-wallet-node', async (request, reply) => {
        try {
            const result = await stopWalletNode();
            reply.status(200).send(result);
        } catch (error) {
            reply.status(500).send({ error: error?.message || error || 'Undefined Error' })
        }
    });

    fastify.post('init-tradelayer', async (request, reply) => {
    
        try {
            // Call the init method from TradeLayerService instance
            const result = await tradeLayerService.init();
            reply.status(200).send({ success: true, result });
        } catch (error) {
            console.error("Error during TradeLayer init:", error);
            reply.status(500).send({ error: error.message || 'Undefined Error' });
        }
    });

    fastify.post('new-config', async (request, reply) => {
        try {
            const { username, password, port, path } = request.body as {
                username: string;
                password: string;
                port: number;
                path: string;
            };
            const options = { username, password, port, path };
            const result = await createConfigFile(options);
            reply.status(200).send(result);
        } catch (error) {
            reply.status(500).send({ error: error.message || 'Undefined Error' })
        }
    });

    fastify.post('build-tx', async (request, reply) => {
        try {
            const { fromKeyPair, toKeyPair, payload, amount, inputs, addPsbt, network } = request.body as IBuildTxConfig;
            const { isApiMode } = request.body as { isApiMode: boolean };
            const txConfig = { fromKeyPair, toKeyPair, payload, amount, inputs, addPsbt, network };
            const hexResult = await buildTx(txConfig, isApiMode);
            reply.status(200).send(hexResult);
        } catch (error) {
            reply.status(500).send({ error: error.message || 'Undefined Error' })
        }
    });

    fastify.post('build-ltcit-tx', async (request, reply) => {
        try {
            const { buyerKeyPair, sellerKeyPair, payload, amount, commitUTXOs, network } = request.body as IBuildLTCITTxConfig;
            const { isApiMode } = request.body as { isApiMode: boolean };
            const txConfig = { buyerKeyPair, sellerKeyPair, payload, amount, commitUTXOs, network };
            const hexResult = await buildLTCInstatTx(txConfig, isApiMode);
            reply.status(200).send(hexResult);
        } catch (error) {
            reply.status(500).send({ error: error.message || 'Undefined Error' })
        }
    });

    fastify.post('sign-tx', async (request, reply) => {
        try {
            const { rawtx, wif, network, inputs, psbtHex } = request.body as ISignTxConfig;
            const result = await signTx({ rawtx, wif, network, inputs, psbtHex });
            reply.status(200).send(result);
        } catch (error) {
            reply.status(500).send({ error: error.message || 'Undefined Error' })
        }
    });

    fastify.post('sign-psbt', async (request, reply) => {
        try {
            const { wif, network, psbtHex } = request.body as ISignPsbtConfig;
            const result = signPsbtRawtTx({ wif, network, psbtHex });
            reply.status(200).send(result);
        } catch (error) {
            reply.status(500).send({ error: error.message || 'Undefined Error' })
        }
    });

    fastify.post('set-api-url', async (request, reply) => {
        try {
            const { apiUrl } = request.body as { apiUrl: string | null };
            fasitfyServer.relayerApiUrl = apiUrl;
            const result = { data: true };
            reply.status(200).send(result);
        } catch (error) {
            reply.status(500).send({ error: error.message || 'Undefined Error' })
        }
    });

    done();
}