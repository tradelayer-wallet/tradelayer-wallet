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

export const initOrderbookConnection = (socketScript: SocketScript, isTestnet: boolean) => {
    orderbookSocketService = new OrderbookSocketService(socketScript, isTestnet);
    return orderbookSocketService;
};

export const initApiService = (isTestnet: boolean) => {
    apiSocketService = new ApiSocketService(isTestnet);
    return apiSocketService;
}

export const clearOrderBookService = () => {
    orderbookSocketService = null;
};

export const clearApiService = () => {
    apiSocketService = null;
}