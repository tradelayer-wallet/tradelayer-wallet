import { FastifyInstance } from "fastify";
import { fasitfyServer } from "../index";
import { startWalletNode, createConfigFile, stopWalletNode } from "../services/node.service";
import { buildLTCInstatTx, buildTx, IBuildLTCITTxConfig, IBuildTxConfig, ISignPsbtConfig, ISignTxConfig, signTx, computeMultisigNative } from "../services/tx-builder.service";
import { signPsbtRawtTx } from "../utils/crypto.util";
import { backOff, BackoffOptions } from "exponential-backoff";
import { TradeLayerService } from '../services/tradelayer.service';  // Correctly import the named export
import { parseDefaultChain, defaultRpcPort, writeEnvKVs } from '../utils/env.util'; // adjust path
import {
  uploadAlgo,
  runAlgo,
  stopAlgo,
  allocateAlgo,
  discoveryAlgo,
  runningAlgo,
  bootstrapAlgoAssets
} from '../services/algo.service';
import { BitvmWatchtowerService } from "../services/bitvm-watchtower.service";


const tradeLayerService = new TradeLayerService();
const bitvmWatchtowerService = new BitvmWatchtowerService();

const backoffOptions: BackoffOptions = {
    maxDelay: 10000,
    numOfAttempts: 5,
}

export const mainRoutes = async (fastify: FastifyInstance, opts: any, done: any) => {
    await bootstrapAlgoAssets();

    fastify.post('rpc-call', async (request, reply) => {
        try {
            const { method, params } = request.body as { method: string, params: any[] };
            if (!fasitfyServer.rpcClient) throw new Error("No RPC Client initialized");
            const _params = params?.length ? params : [];
            const res = await backOff(() => fasitfyServer.rpcClient.call(method, ..._params), backoffOptions);
            reply.status(200).send(res);
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || error || 'Undefined Error' })
        }
    });

    
fastify.post('start-wallet-node', async (request, reply) => {
  try {
    const { network, startclean, reindex, path } = request.body as {
      network: string; startclean: boolean; reindex: boolean; path: string;
    };

    // derive chain/network & rpcPort from the label you already pass (e.g. 'LTCLIVE'|'LTCTEST')
    const { chain, network: net } = parseDefaultChain(network);
    const rpcPort = defaultRpcPort(chain, net);
    console.log('config data '+rpcPort+' '+chain+' '+network)
    // persist for both desktop + backend
    writeEnvKVs({
      DEFAULT_CHAIN: network, // keep your label
      CHAIN: chain,
      NETWORK: net,
      DATADIR: path,
      RPC_PORT: rpcPort,
    });

    const _isTestNetBool = network.endsWith('TEST');
    const walletNodeOptions = {
      testnet: _isTestNetBool,
      datadir: path,
      reindex,
      startclean,
      rpcport: rpcPort,          // 👈 pin the port we expect
    };

    const result = await startWalletNode(walletNodeOptions);
    reply.status(200).send(result);
  } catch (error: any) {
    reply.status(500).send({ error: error.message || 'Undefined Error' });
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

    // main-routes.ts (Fastify)
	fastify.post('compute-multisig', async (request, reply) => {
	  try {
	    const { m, pubKeys, network } = request.body as any;
	    const result = await computeMultisigNative(m, pubKeys, network);
	    reply.status(200).send({data: result});
	  } catch (error: any) {
	    reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
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

    fastify.post('bitvm/watchtower/start', async (request, reply) => {
      try {
        const body = (request.body || {}) as any;
        const data = await bitvmWatchtowerService.start(body);
        reply.status(200).send({ data });
      } catch (error: any) {
        reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
      }
    });

    fastify.post('bitvm/watchtower/run', async (request, reply) => {
      try {
        const body = (request.body || {}) as any;
        const data = await bitvmWatchtowerService.run(body);
        reply.status(200).send({ data });
      } catch (error: any) {
        reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
      }
    });

    fastify.post('bitvm/watchtower/stop', async (_request, reply) => {
      try {
        const data = bitvmWatchtowerService.stop();
        reply.status(200).send({ data });
      } catch (error: any) {
        reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
      }
    });

    fastify.get('bitvm/watchtower/status', async (_request, reply) => {
      try {
        const data = bitvmWatchtowerService.status();
        reply.status(200).send({ data });
      } catch (error: any) {
        reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
      }
    });

    fastify.get('bitvm/watchtower/logs', async (request, reply) => {
      try {
        const q = (request.query || {}) as any;
        const limit = Number(q.limit || 150);
        const data = bitvmWatchtowerService.getLogs(limit);
        reply.status(200).send({ data });
      } catch (error: any) {
        reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
      }
    });

    // --- Algo routes (function handlers; same style as other routes) ---
    fastify.post('algo/upload', async (request, reply) => {
      //try { 
      await uploadAlgo(request, reply); 
      //}catch (e: any) { 
      //reply.status(500).send({ error: e?.message || 'Upload failed' }); 
      //}
    });

    fastify.post('algo/run', async (request, reply) => {
      try { await runAlgo(request, reply); }
      catch (e: any) { reply.status(500).send({ error: e?.message || 'Run failed' }); }
    });

    fastify.post('/algo/stop', async (request, reply) => {
      try {
        // SAFE logging (no stringify of request/reply)
        console.log('[BE] /algo/stop hit body=', request.body);

        await stopAlgo(request, reply);  // this will send the reply
      } catch (e: any) {
        console.error('[BE] /algo/stop error:', e?.message || e);
        if (!reply.sent) reply.status(500).send({ error: e?.message || 'Stop failed' });
      }
    });

    fastify.post('algo/allocate', async (request, reply) => {
      try { await allocateAlgo(request, reply); }
      catch (e: any) { reply.status(500).send({ error: e?.message || 'Allocate failed' }); }
    });

    
    fastify.get('algo/discovery', async (request, reply) => {
      try {
        const list = await discoveryAlgo(request, reply);
        reply.send(list);
      } catch (e:any) {
        console.error('GET /algo/list failed:', e);
        reply.status(500).send({ error: e.message || 'list failed' });
      }
    });

    fastify.get('algo/running', async (request, reply) => {
      try {
        const list = await runningAlgo(request,reply);
        reply.send(list);
      } catch (e:any) {
        console.error('GET /algo/running failed:', e);
        reply.status(500).send({ error: e.message || 'running failed' });
      }
    });
    // --- end algo routes ---


    done();
}
