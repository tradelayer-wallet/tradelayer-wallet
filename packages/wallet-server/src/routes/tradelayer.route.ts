import { FastifyInstance } from "fastify";

import * as Main from '../tradelayer/main.js';
import * as TallyMap from '../tradelayer/tally.js';
import * as PropertyManager from '../tradelayer/property.js';
import * as Consensus from '../tradelayer/consensus.js';

export const tlRoutes = (fastify: FastifyInstance, opts: any, done: any) => {

    fastify.post('/init', async (request, reply) => {
        try {
            throw new Error("Not implemented");
            const isTest = true;
            const mainProcessor = Main.getInstance(isTest);
            mainProcessor.initialize();
            reply.status(200).send({ message: 'Main process initialized successfully' });
        } catch (error) {
            reply.status(500).send({ error: error || 'Undefined Error' })
        }
    });

    fastify.post('/getAllBalancesForAddress', async (request, reply) => {
        try {
            throw new Error("Not implemented");
            const body = request.body as any;
            const params = body.params as any[];
            const address = params[0];

            console.log(`Getting balances for address: ${address}`)
            const tallyMapInstance = await TallyMap.getInstance();
            if (!tallyMapInstance) {
                throw new Error("Failed to get TallyMap instance");
            }
            await tallyMapInstance.loadFromDB();
            const balances = tallyMapInstance.getAddressBalances(address);
            reply.status(200).send(balances);
        } catch (error) {
            console.error(error); // Log the full error for debugging
            reply.status(500).send('Error: ' + error.message);
        }
    });

    fastify.post('/listProperties', async (request, reply) => {
        try {
            throw new Error("Not implemented");
            const propertiesArray = await PropertyManager.getPropertyIndex();
            reply.status(200).send(propertiesArray);
        } catch (error) {
            reply.status(500).send('Error: ' + error.message);
        }
    });

    fastify.post('/getMaxProcessedHeight', async (request, reply) => {
        try {
            throw new Error("Not implemented");
            const blockHeight = await Consensus.getMaxProcessedBlock();
            reply.status(200).send(blockHeight);
        } catch (error) {
            reply.status(500).send('Error: ' + error.message);
        }
    });

    done();
}