import { FastifyInstance } from "fastify";
import { generateNewWallet, getKeyPair, getManyKeyPair, TNetwork } from "../utils/crypto.util";

export const keysRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.post('/new-wallet', (request, reply) => {
        try {
            const { network } = request.body as { network: TNetwork };
            const result = generateNewWallet(network);
            if (result.error) throw new Error(result.error);
            reply.status(200).send(result);
        } catch (error) {
            reply.status(500).send({ error: error.message || 'Undefined Error' })
        }
    });

    fastify.post('/get-address', (request, reply) => {
        try {
            const { network, mnemonic, derivatePath } = request.body as 
                { network: TNetwork, mnemonic: string, derivatePath: string };
            
            const result = getKeyPair(network, mnemonic, derivatePath);
            if (result.error) throw new Error(result.error);
            reply.status(200).send(result);
        } catch (error) {
            reply.status(500).send({ error: error.message || 'Undefined Error' })
        }
    });

    fastify.post('/get-address-file', (request, reply) => {
        try {
            const { network, mnemonic, walletObjRaw } = request.body as
                { network: TNetwork, mnemonic: string, walletObjRaw: any };
            process.send({network, mnemonic, walletObjRaw});
            const result = getManyKeyPair(network, mnemonic, walletObjRaw);
            process.send({result});
            if (result.error) throw new Error(result.error);
            reply.status(200).send(result);
        } catch (error) {
            reply.status(500).send({ error: error.message || 'Undefined Error' })
        }
    });

    done();
}