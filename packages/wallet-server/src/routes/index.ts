import { FastifyInstance } from "fastify";
import { socketRoutes } from './socket-service.route';

export const handleRoutes = (server: FastifyInstance, socketScript: any) => {
    server.register(socketRoutes(socketScript), { prefix: '/ss' });
}