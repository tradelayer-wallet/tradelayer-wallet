type TEnpoint = {
    [k: string]: {
        orderbookApiUrl: string,
        relayerUrl: string,
    } 
};

export const ENDPOINTS: TEnpoint = {
    LTC: {
        orderbookApiUrl: "ws://172.81.181.19:3001/ws",
        relayerUrl: "http://172.81.181.19:9191",
    },
    LTCTEST: {
        orderbookApiUrl: "ws://172.81.181.19:3001/ws",
        relayerUrl: "http://172.81.181.19:8191",
    },
    BTC: {
        orderbookApiUrl: "ws://172.81.181.19:3001/ws",
        relayerUrl: "http://172.81.181.19:9191",
    }
};
