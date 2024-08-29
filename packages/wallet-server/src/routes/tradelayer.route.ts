import { FastifyInstance } from "fastify";
// import { fasitfyServer } from "..";
import axios from 'axios';

const baseURL = 'http://localhost:3000/';

export const tlRoutes = (fastify: FastifyInstance, opts: any, done: any) => {

    fastify.post('/init', async (request, reply) => {
        try {
            // await fasitfyServer.tradelayerService.start();
            const res = await axios.post(baseURL + 'tl_initmain', { test: true });
            if (res.data.error) throw new Error(res.data.error);
            reply.status(200).send({ message: res.data });
        } catch (error) {
            reply.status(500).send({ error: error.message || 'Undefined Error' })
        }
    });

    fastify.post('/getAllBalancesForAddress', async (request, reply) => {
        try {
            const body = request.body as any;
            const params = body.params as any[];
            const address = params[0];
            const res = await axios.post(baseURL + 'tl_getAllBalancesForAddress', { params: address });
            // const addressBalanceData = fasitfyServer.tradelayerService.tradeLayerInstance.tallyManager.getAddressData(address);
            // const arrayBalance = Object.values(addressBalanceData || {})
            //     .map((balance: any, index: number) => ({ propertyId: Object.keys(addressBalanceData)[index], balance }));
            reply.status(200).send(res.data);
        } catch (error) {
            console.error(error); // Log the full error for debugging
            reply.status(500).send('Error: ' + error.message);
        }
    });

    fastify.post('/getChannel', async (request, reply) => {
        try {
            const channel = await axios.post(baseURL + 'tl_getChannel', { params: address });
            reply.status(200).send(channel);
        } catch (error) {
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
            const res = await axios.post(baseURL + 'tl_getMaxProcessedHeight');
            reply.status(200).send(res.data || 0 );
        } catch (error) {
            reply.status(500).send('Error: ' + error.message);
        }
    });

     fastify.post('/getMaxParsedHeight', async (request, reply) => {
        try {
            const res = await axios.post(baseURL + 'tl_getMaxParsedHeight');
            reply.status(200).send(res.data || 0 );
        } catch (error) {
            //reply.status(500).send('Error: ' + error.message);
        }
    });

    fastify.post('/loadWallet', async (request, reply) => {
        try {
            const res = await axios.post(baseURL + 'tl_loadWallet');
            reply.status(200).send(res.data || 0 );
        } catch (error) {
            reply.status(500).send('Error: ' + error.message);
        }
    });


    done();
}