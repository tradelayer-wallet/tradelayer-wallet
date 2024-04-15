import { FastifyInstance } from "fastify";
import { fasitfyServer } from "..";

export const tlRoutes = (fastify: FastifyInstance, opts: any, done: any) => {

    fastify.post('/init', async (request, reply) => {
        try {
            await fasitfyServer.tradelayerService.start();
            reply.status(200).send({ message: 'Main process initialized successfully' });
        } catch (error) {
            reply.status(500).send({ error: error.message || 'Undefined Error' })
        }
    });

    fastify.post('/getAllBalancesForAddress', async (request, reply) => {
        try {
            const body = request.body as any;
            const params = body.params as any[];
            const address = params[0];
            const addressBalanceData = fasitfyServer.tradelayerService.tradeLayerInstance.tallyManager.getAddressData(address);
            const arrayBalance = Object.values(addressBalanceData || {})
                .map((balance: any, index: number) => ({ propertyId: Object.keys(addressBalanceData)[index], balance }));
            reply.status(200).send(arrayBalance);
        } catch (error) {
            console.error(error); // Log the full error for debugging
            reply.status(500).send('Error: ' + error.message);
        }
    });

    fastify.post('/listProperties', async (request, reply) => {
        try {
            throw new Error("Not implemented");
            // const propertiesArray = await PropertyManager.getPropertyIndex();
            // reply.status(200).send(propertiesArray);
        } catch (error) {
            reply.status(500).send('Error: ' + error.message);
        }
    });

    fastify.post('/getMaxProcessedHeight', async (request, reply) => {
        try {
            const maxIndexedBlock = fasitfyServer.tradelayerService.tradeLayerInstance.txIndexManager.maxProcessedBlock;
            reply.status(200).send(maxIndexedBlock);
        } catch (error) {
            reply.status(500).send('Error: ' + error.message);
        }
    });

    done();
}