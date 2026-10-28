import { FastifyInstance } from "fastify";
import { generateNewWallet, getKeyPair, getManyKeyPair, TNetwork } from "../utils/crypto.util";
import { sendError } from "../utils/common.util";

export const keysRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
    // The key functions throw on an unknown network ('Network not found!') instead of returning
    // { error }; each route answers a throw through sendError, as it did the returned error.
    fastify.post('new-wallet', (request, reply) => {
        try {
            const { network } = request.body as { network: TNetwork };
            const result = generateNewWallet(network);
            reply.status(200).send(result);
        } catch (error) {
            sendError(reply, error)
        }
    });

    fastify.post('get-address', (request, reply) => {
        try {
            const { network, mnemonic, derivatePath } = request.body as 
                { network: TNetwork, mnemonic: string, derivatePath: string };
            
            const result = getKeyPair(network, mnemonic, derivatePath);
            reply.status(200).send(result);
        } catch (error) {
            sendError(reply, error)
        }
    });

    fastify.post('get-address-file', (request, reply) => {
        try {
            const { network, mnemonic, walletObjRaw } = request.body as
                { network: TNetwork, mnemonic: string, walletObjRaw: any };
            const result = getManyKeyPair(network, mnemonic, walletObjRaw);
            reply.status(200).send(result);
        } catch (error) {
            sendError(reply, error)
        }
    });

    done();
}