import { FastifyInstance } from 'fastify';
import { proxyWalletMethod } from '../services/rpc-proxy.service';

export const rpcRoutes = (fastify: FastifyInstance, _opts: any, done: any) => {
  fastify.post(':method', async (request, reply) => {
    try {
      const { method } = request.params as { method: string };
      const data = await proxyWalletMethod(method, request.body);
      reply.status(200).send(data);
    } catch (error: any) {
      reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
    }
  });

  done();
};
