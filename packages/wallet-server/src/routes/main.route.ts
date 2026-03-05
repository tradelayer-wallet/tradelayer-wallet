import { FastifyInstance } from "fastify";
import { fasitfyServer } from "../index";
import { startWalletNode, createConfigFile, stopWalletNode } from "../services/node.service";
import { buildLTCInstatTx, buildTx, IBuildLTCITTxConfig, IBuildTxConfig, ISignPsbtConfig, ISignTxConfig, signTx } from "../services/tx-builder.service";
import { bitvmEmitFraudProof, bitvmWatchtowerScan, bitvmWatchtowerStart, bitvmWatchtowerStop, bitvmWatchtowerTick, fetchBitvmStatus, getBitvmWatchtowerStatus } from "../services/bitvm.service";
import { signPsbtRawtTx } from "../utils/crypto.util";
import type { CollatorStartRequest, RustSequencerStartRequest } from "../services/collator.service";

export const mainRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.post('rpc-call', async (request, reply) => {
        try {
            const { method, params } = request.body as { method: string, params: any[] };
            if (!fasitfyServer.rpcClient) throw new Error("No RPC Client initialized");
            const _params = params?.length ? params : [];
            const res = await fasitfyServer.rpcClient.call(method, ..._params);
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

    fastify.get('bitvm/status', async (request, reply) => {
        try {
            const q = request.query as { propertyId?: string; dlcRef?: string };
            const propertyId = Number(q?.propertyId || 0);
            const status = await fetchBitvmStatus({
                propertyId: Number.isFinite(propertyId) && propertyId > 0 ? propertyId : undefined,
                dlcRef: q?.dlcRef,
            });
            reply.status(200).send({ data: status });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || 'Undefined Error' });
        }
    });

    fastify.post('bitvm/watchtower-tick', async (request, reply) => {
        try {
            const body = (request.body || {}) as { propertyId?: number; dlcRef?: string };
            const status = await bitvmWatchtowerTick(body);
            reply.status(200).send({ data: status });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || 'Undefined Error' });
        }
    });

    fastify.post('bitvm/emit-fraud-proof', async (request, reply) => {
        try {
            const body = (request.body || {}) as { propertyId?: number; dlcRef?: string };
            const status = await bitvmEmitFraudProof(body);
            reply.status(200).send({ data: status });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || 'Undefined Error' });
        }
    });

    fastify.get('bitvm/watchtower/status', async (_request, reply) => {
        try {
            reply.status(200).send({ data: getBitvmWatchtowerStatus() });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || 'Undefined Error' });
        }
    });

    fastify.post('bitvm/watchtower/start', async (request, reply) => {
        try {
            const body = (request.body || {}) as { intervalMs?: number; autoFraudProof?: boolean; propertyId?: number; dlcRef?: string };
            const st = bitvmWatchtowerStart(body);
            reply.status(200).send({ data: st });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || 'Undefined Error' });
        }
    });

    fastify.post('bitvm/watchtower/stop', async (_request, reply) => {
        try {
            const st = bitvmWatchtowerStop();
            reply.status(200).send({ data: st });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || 'Undefined Error' });
        }
    });

    fastify.post('bitvm/watchtower/scan', async (request, reply) => {
        try {
            const body = (request.body || {}) as { propertyId?: number; dlcRef?: string };
            const data = await bitvmWatchtowerScan(body);
            reply.status(200).send({ data });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || 'Undefined Error' });
        }
    });

    fastify.get('collator/status', async (_request, reply) => {
        try {
            const st = fasitfyServer.collatorService.status();
            reply.status(200).send({ data: st });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || 'Undefined Error' });
        }
    });

    fastify.post('collator/start', async (request, reply) => {
        try {
            const body = (request.body || {}) as CollatorStartRequest;
            const st = await fasitfyServer.collatorService.start(body);
            reply.status(200).send({ data: st });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || 'Undefined Error' });
        }
    });

    fastify.post('collator/stop', async (_request, reply) => {
        try {
            const st = await fasitfyServer.collatorService.stop();
            reply.status(200).send({ data: st });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || 'Undefined Error' });
        }
    });

    fastify.get('rust/status', async (_request, reply) => {
        try {
            const st = fasitfyServer.collatorService.rustStatus();
            reply.status(200).send({ data: st });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || 'Undefined Error' });
        }
    });

    fastify.post('rust/start', async (request, reply) => {
        try {
            const body = (request.body || {}) as RustSequencerStartRequest;
            const st = await fasitfyServer.collatorService.startRust(body);
            reply.status(200).send({ data: st });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || 'Undefined Error' });
        }
    });

    fastify.post('rust/stop', async (_request, reply) => {
        try {
            const st = await fasitfyServer.collatorService.stopRust();
            reply.status(200).send({ data: st });
        } catch (error: any) {
            reply.status(500).send({ error: error?.message || 'Undefined Error' });
        }
    });

    done();
}
