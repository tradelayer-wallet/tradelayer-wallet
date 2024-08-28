type TEnpoint = {
    [k: string]: {
        orderbookApiUrl: string,
        relayerUrl: string,
    } 
};

export const ENDPOINTS: TEnpoint = {
    LTC: {
        orderbookApiUrl: "http://172.81.181.19:9190",
        relayerUrl: "http://172.81.181.19:9191",
    },
    LTCTEST: {
        orderbookApiUrl: "http://172.81.181.19:9191",
        relayerUrl: "http://172.81.181.19:8191",
    },
};
