import { FastifyInstance } from "fastify";
import { fasitfyServer } from "../index";
import { startWalletNode, createConfigFile, stopWalletNode, createRpcClientFromDatadir } from "../services/node.service";
import { buildBitvmDlcSetupBlueprint, IBitvmDlcSetupConfig } from "../services/bitvm-dlc.service";
import { syncBitvmProceduralState } from "../services/bitvm-procedural-sync.service";
import { buildBitvmDlcFundingTx, buildLTCInstatTx, buildTx, IBitvmDlcMultiOutputTxConfig, IBuildLTCITTxConfig, IBuildTxConfig, ISignPsbtConfig, ISignTxConfig, signTx, computeMultisigNative } from "../services/tx-builder.service";
import { signPsbtRawtTx } from "../utils/crypto.util";
import { backOff, BackoffOptions } from "exponential-backoff";
import { parseDefaultChain, defaultRpcPort, writeEnvKVs } from '../utils/env.util'; // adjust path
import { proxyWalletMethod } from "../services/rpc-proxy.service";
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
import { getTradeLayerSyncStatus } from "../services/tradelayer-sync.service";


const bitvmWatchtowerService = new BitvmWatchtowerService();

const backoffOptions: BackoffOptions = {
    maxDelay: 10000,
    numOfAttempts: 5,
}

export const mainRoutes = async (fastify: FastifyInstance, opts: any, done: any) => {
    await bootstrapAlgoAssets();

    const isTransientRpcStartupError = (error: any) => {
      const msg = String(error?.message || error || '').toLowerCase();
      return error?.code === 'ECONNREFUSED'
        || error?.code === 'ETIMEDOUT'
        || error?.code === -28
        || msg.includes('econnrefused')
        || msg.includes('connect econnrefused')
        || msg.includes('connection refused')
        || msg.includes('socket hang up')
        || msg.includes('etimedout')
        || msg.includes('loading block index')
        || msg.includes('rewinding blocks')
        || msg.includes('warming up');
    };

    fastify.post('rpc-call', async (request, reply) => {
        try {
            const { method, params } = request.body as { method: string, params: any[], walletLabel?: string, walletName?: string };
            if (String(method || '').trim() === 'getblockchaininfo' && !fasitfyServer.rpcClient) {
              const rpcClient = createRpcClientFromDatadir(process.env.DATADIR, Number(process.env.RPC_PORT));
              if (rpcClient) {
                try {
                  const probe = await rpcClient.call('getblockchaininfo');
                  if (probe?.data && !probe?.error) {
                    fasitfyServer.rpcClient = rpcClient;
                    fasitfyServer.rpcPort = Number(process.env.RPC_PORT) || 19332;
                  } else if (isTransientRpcStartupError(probe?.error)) {
                    reply.status(200).send({ error: String(probe?.error || 'Loading block index...') });
                    return;
                  }
                } catch (probeError: any) {
                  if (isTransientRpcStartupError(probeError)) {
                    reply.status(200).send({ error: String(probeError?.message || probeError || 'Loading block index...') });
                    return;
                  }
                  throw probeError;
                }
              }
            }
            const res = await backOff(() => proxyWalletMethod(method, request.body), backoffOptions);
            reply.status(200).send(res);
        } catch (error: any) {
            if (isTransientRpcStartupError(error)) {
              reply.status(200).send({ error: error?.message || error || 'Loading Litecoin RPC...' });
              return;
            }
            reply.status(500).send({ error: error?.message || error || 'Undefined Error' })
        }
    });

    
fastify.post('start-wallet-node', async (request, reply) => {
  try {
    const { network, startclean, reindex, allowRescan, path } = request.body as {
      network: string; startclean: boolean; reindex: boolean; allowRescan?: boolean; path: string;
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
      WATCHONLY_RESCAN_OPT_IN: allowRescan ? '1' : '0',
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

    fastify.post('build-bitvm-dlc-setup', async (request, reply) => {
      try {
        const body = request.body as IBitvmDlcSetupConfig;
        const result = await buildBitvmDlcSetupBlueprint(body);
        reply.status(200).send({ data: result });
      } catch (error: any) {
        reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
      }
    });

    fastify.post('build-bitvm-dlc-tx', async (request, reply) => {
      try {
        const body = request.body as IBitvmDlcMultiOutputTxConfig;
        const { isApiMode } = request.body as { isApiMode: boolean };
        const result = await buildBitvmDlcFundingTx(body, isApiMode);
        reply.status(200).send(result);
      } catch (error: any) {
        reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
      }
    });

    fastify.post('bitvm/sync-procedural', async (request, reply) => {
      try {
        const body = (request.body || {}) as { holderAddress?: string; propertyId?: number; state?: string };
        const data = syncBitvmProceduralState(body);
        reply.status(200).send({ data });
      } catch (error: any) {
        reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
      }
    });

    fastify.post('init-tradelayer', async (request, reply) => {
        try {
            // Call the init method from TradeLayerService instance
            const result = await fasitfyServer.tradelayerService.init();
            reply.status(200).send({ success: true, result });
        } catch (error) {
            console.error("Error during TradeLayer init:", error);
            reply.status(500).send({ error: error.message || 'Undefined Error' });
        }
    });

    fastify.get('tradelayer/sync-status', async (_request, reply) => {
        try {
            const data = await getTradeLayerSyncStatus();
            reply.status(200).send({ data });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
        }
    });

    fastify.get('tradelayer/collator-status', async (_request, reply) => {
        try {
            const data = {
              ...(fasitfyServer?.collatorPeerService?.status?.() || {}),
              wsRelay: fasitfyServer?.wsRelayService?.status?.() || null,
            };
            reply.status(200).send({ data });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
        }
    });

    fastify.post('tradelayer/set-collator-config', async (request, reply) => {
        try {
            const body = (request.body || {}) as {
                collatorUrls?: string[] | string;
                autoContribute?: boolean;
            };
            const urls = Array.isArray(body.collatorUrls)
                ? body.collatorUrls
                : String(body.collatorUrls || '')
                    .split(/[\n,]+/)
                    .map((s) => s.trim())
                    .filter(Boolean);
            const normalizedUrls = Array.from(new Set(urls.filter(Boolean)));
            const autoContribute = body.autoContribute === undefined ? true : !!body.autoContribute;

            writeEnvKVs({
                TL_COLLATOR_WS_URLS: normalizedUrls.join(','),
                TL_COLLATOR_AUTO_CONTRIBUTE: autoContribute ? '1' : '0',
            });

            reply.status(200).send({
                data: {
                    collatorUrls: normalizedUrls,
                    autoContributeEnabled: autoContribute,
                },
            });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
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

    fastify.post(':method', async (request, reply) => {
      try {
        const { method } = request.params as { method: string };
        const data = await proxyWalletMethod(method, request.body);
        reply.status(200).send(data);
      } catch (error: any) {
        reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
      }
    });
    // --- end algo routes ---


    done();
}
