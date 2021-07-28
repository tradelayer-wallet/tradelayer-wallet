import { FastifyInstance } from "fastify"
import SocketScript from "../socket-script";
import { LITOptions, TradeTypes } from "../socket-script/common/types";

export const socketRoutes = (socketScript: SocketScript) => {
    return (fastify: FastifyInstance, opts: any, done: any) => {
        fastify.get('/connect', (request, reply) => {
            const { user, pass, port } = request.query as { user: string, pass: string, port: number};
            if (!user || !pass || !port) {
                reply.send(false);
                return;
            };
            socketScript.connect({ user, pass, port })
                .then((isConnected: boolean) => {
                    reply.send(isConnected);
                });
        });
    
        fastify.get('/listStart', (request, reply) => {
            console.log("listStart!");
            const { address } = request.query as { address: string };
            if (!address) {
                reply.send(false);
                return;
            }
            socketScript.startListener({address, logs: true});
        });
    
        fastify.get('/listStop', () => {
            console.log("listStop!");
            socketScript.stopListener();
        });
    
        fastify.get('/initTrade', (request, reply) => {
            const { dealer, trade, keyPair } = request.query as { dealer: string, trade: string, keyPair: string };
            try {
                const dealerObj = JSON.parse(dealer);
                const tradeObj = JSON.parse(trade);
                const keyPairObj = JSON.parse(keyPair);
                if (tradeObj.propIdForSale === 999 || tradeObj.propIdDesired === 999) {
                    const isBuy = tradeObj.propIdForSale === 999; 
                    const host = dealerObj.ip;
                    const tradeOptions: LITOptions = {
                        type: TradeTypes.LTC_INSTANT_TRADE,
                        propertyid: isBuy ? tradeObj.propIdDesired : tradeObj.propIdForSale,
                        amount: tradeObj.amount,
                        price: tradeObj.price,
                        address: keyPairObj.address,
                        pubkey: keyPairObj.pubKey,
                    };
                    const options = { logs: true, send: false };
                    const trade = socketScript.ltcInstantTrade(host, tradeOptions, options);
                    trade.onReady().then(onReady => {
                        reply.send(onReady);
                    })
                } else {
                    reply.send({ data: 'half-Success!' });
                }
            } catch(error) {
                reply.send({ error: error.message || 'Fail building Trade' });
            }
        });

        done();
    }
};