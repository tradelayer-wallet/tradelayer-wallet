import { FastifyInstance } from "fastify";
import { socketRoutes } from './socket-service.route';
import { keysRoutes } from './keys.route';

export const handleRoutes = (server: FastifyInstance, socketScript: any) => {
    server.register(socketRoutes(socketScript), { prefix: '/ss' });
    server.register(keysRoutes, { prefix: '/keys' });
}