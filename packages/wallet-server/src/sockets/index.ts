import { FastifyInstance } from "fastify"
import { SocketScript } from '../socket-script/socket-script';
import { ApiSocketService } from "./api-socket.-service";
import { OrderbookSocketService } from "./orderbook-socket-service";
import { WalletSocketSevice } from "./wallet-socket-service";

export let walletSocketSevice: WalletSocketSevice;
export let orderbookSocketService: OrderbookSocketService;
export let apiSocketService: ApiSocketService;

export const myVersions = {
    nodeVersion: '0.0.3',
    walletVersion: '0.0.3',
};

export const initWalletConnection = (app: FastifyInstance, socketScript: SocketScript) => {
    walletSocketSevice = new WalletSocketSevice(app, socketScript);
    return walletSocketSevice
};

export const initOrderbookConnection = (socketScript: SocketScript, url: string) => {
    if (orderbookSocketService) {
        orderbookSocketService.terminate();
        orderbookSocketService = null;
    }
    orderbookSocketService = new OrderbookSocketService(socketScript, url);
    return orderbookSocketService;
};

export const disconnectFromOrderbook = () => {
    if (orderbookSocketService) {
        orderbookSocketService.terminate();
        orderbookSocketService = null;
    }
}

export const initApiService = (isTestnet: boolean) => {
    if (apiSocketService) {
        apiSocketService.terminate();
        apiSocketService = null;
    }
    apiSocketService = new ApiSocketService(isTestnet);
    return apiSocketService;
}

export const clearOrderBookService = () => {
    orderbookSocketService = null;
};

export const clearApiService = () => {
    apiSocketService = null;
}