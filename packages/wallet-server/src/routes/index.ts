import { FastifyInstance } from "fastify";
import { keysRoutes } from './keys.route';
import { mainRoutes } from "./main.route";

export const handleRoutes = (server: FastifyInstance) => {
    server.register(keysRoutes, { prefix: '/keys/' });
    server.register(mainRoutes, { prefix: '/api/' });
}