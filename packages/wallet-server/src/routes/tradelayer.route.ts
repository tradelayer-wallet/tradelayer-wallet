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
            
            const res = await axios.post(baseURL + 'tl_initmain', { wallet: true });
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

    fastify.post('/getChannel', async (request: FastifyRequest<{ Body: [string] }>, reply: FastifyReply) => {
      console.log('Inside getChannel Fastify, Request Body: ' + JSON.stringify(request.body));
        try {
            // Extract the address from the array in request.body
            const [address] = request.body;

            // Prepare the body to match the expected format for the listener
            const channelRequest = { params: address };

            // Make the API call to the external service with the correct format
            const channel = await axios.post(baseURL + 'tl_getChannel', channelRequest);

            // Send the response back to the client
            reply.status(200).send(channel.data);  // Return the channel data from the response
        } catch (error) {
            console.error('Error in getChannel:', error.message);
            reply.status(500).send('Error: ' + error.message);
        }
    });

    /*fastify.post('/getChannel', async (request, reply) => {

        try {
            const channel = await axios.post(baseURL + 'tl_getChannel', request.body);
            reply.status(200).send(channel.channel);
        } catch (error) {
            reply.status(500).send('Error: ' + error.message);
        }
    });*/

    fastify.post('/test', async (request, reply) => {
        console.log('Received test request');
        reply.status(200).send({ message: 'Test route working' });
    });

    fastify.post('/getChannelColumn', async (request: FastifyRequest<{ Body: [string, string] }>, reply:FastifyReply) => {
        console.log('Inside getChannelColumn Fastify, Request Body: ' + JSON.stringify(request.body));
        try {
            // Extract channel and cpAddress from the array in request.body
            const [channel, cpAddress] = request.body;

            // Make the API call to the external service with the correct format
            const column = await axios.post(baseURL + 'tl_getChannelColumn', { channel, cpAddress });

            // Send the response back to the client
            reply.status(200).send(column.data);  // Assuming column is returned in column.data
        } catch (error) {
            console.error('Error in getChannelColumn:', error.message);
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