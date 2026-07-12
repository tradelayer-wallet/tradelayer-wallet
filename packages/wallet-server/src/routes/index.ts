import { FastifyInstance } from "fastify";
import { keysRoutes } from './keys.route';
import { explorerRoutes } from './explorer.route';
import { mainRoutes } from "./main.route";
import { tlRoutes } from "./tradelayer.route";
import { rpcRoutes } from "./rpc.route";
import { addressRoute } from "./address.route";

export const handleRoutes = (server: FastifyInstance) => {
    server.register(keysRoutes, { prefix: '/keys/' });
    server.register(explorerRoutes, { prefix: '/explorer/' });
    server.register(mainRoutes, { prefix: '/api/' });
    server.register(tlRoutes, { prefix: '/tl/' });
    server.register(rpcRoutes, { prefix: '/rpc/' });
    server.register(addressRoute, { prefix: '/address/' });
}
