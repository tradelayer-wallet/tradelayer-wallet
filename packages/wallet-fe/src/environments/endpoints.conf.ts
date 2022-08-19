type TEnpoint = {
    [k: string]: {
        orderbookApiUrl: string,
        relayerUrl: string,
    } 
};

export const ENDPOINTS: TEnpoint = {
    LTC: {
        orderbookApiUrl: "not-working",
        relayerUrl: "http://170.75.174.87:9191",
    },
    LTCTEST: {
        orderbookApiUrl: "not-working",
        relayerUrl: "http://170.75.174.87:8191",
    },
};