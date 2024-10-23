import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
// import { fasitfyServer } from "..";
import axios from 'axios';

const baseURL = 'http://localhost:3000/';
let setInit = false
let initializing = false

interface ChannelRequestBody {
    channel: string;
    cpAddress: string;
}

// Define the interface for GetChannelRequestBody
interface GetChannelRequestBody {
    params: string[];
}



export const tlRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
    
    fastify.post('/init', async (request, reply) => {

    console.log('set init in init route '+setInit+' and initializing '+initializing)
    if(setInit===true||initializing===true){
         console.log('bouncing off tl init')
         return console.log("TL Main Initialized already or initializing")
    }
    console.log('inside the fastify init '+baseURL+'tl_initmain')
        try {
            initializing = true; // Only set this to true once the init is done successfully
            
            const res = await axios.post(baseURL + 'tl_initmain', { test: true });
            if (res.data.error) throw new Error(res.data.error);
            //reply.status(200).send({ message: res.data });
            console.log('TL Init successfully');
            setInit=true
            initializing=false
            reply.status(200).send({ message: 'TL Main initialized successfully' });
        } catch (error) {
            initializing =false
            //console.log('Error initializing TL', error);
            reply.status(500).send({ error: error.message || 'Undefined Error' });
        }finally {
            initializing = false; // Ensure that initializing flag is reset in all cases
        }
            // await fasitfyServer.tradelayerService.start();
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

    fastify.post('/getChannel', async (request: FastifyRequest<{ Body: GetChannelRequestBody }>, reply: FastifyReply) => {
        const { params } = request.body;
        const address = params[0];
        const channel = await axios.post(baseURL + 'tl_getChannel', { params: address });
        console.log('Address:', address);  // This should log the address properly

        // Return a JSON object instead of a string
        reply.status(200).send(channel);
    });


    /*fastify.post('/getChannel', async (request, reply) => {

        try {
            const body = request.body as any;
            const params = body.params as any[];
            const address = params[0];
            console.log(address)
            const channel = await axios.post(baseURL + 'tl_getChannel', { params: address });
            reply.status(200).send(channel.channel);
        } catch (error) {
            reply.status(500).send('Error: ' + error.message);
        }
    });*/

    fastify.post('/test', async (request, reply) => {
        console.log('Received test request');
        reply.status(200).send({ message: 'Test route working' });
    });

     fastify.post('/getChannelColumn', async (request: FastifyRequest<{ Body: ChannelRequestBody }>, reply: FastifyReply) => {
        console.log('inside getChannel fastify' + JSON.stringify(request.body));
        try {
            const { channel, cpAddress } = request.body;
            const column = await axios.post(baseURL + 'tl_getChannelColumn', { params: [channel, cpAddress] });
            reply.status(200).send(column);
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