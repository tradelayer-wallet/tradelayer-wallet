// fastify-server.ts

import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { handleRoutes } from './routes';
import { RpcClient } from 'tl-rpc';
import { SocketService } from './services/socket.service';
import { IOBSocketServiceOptions, OBSocketService } from './services/ob-sockets.service';
import killPort from 'kill-port'; // Ensure 'kill-port' is installed
import { TradeLayerService } from './services/tradelayer.service';
import { Websocket } from 'hyper-express'; // Ensure 'hyper-express' is installed and types are declared

export class FastifyServer {
    private _server: FastifyInstance;
    public rpcClient: RpcClient;
    public rpcPort: number;
    public mainSocketService: SocketService;
    public obSocketService: OBSocketService;
    public tradelayerService: TradeLayerService;
    public relayerApiUrl: string | null = null;

    constructor(
        private port: number, 
        options: FastifyServerOptions,
        private safeClose: () => void,
    ) {
        this._server = Fastify(options);
        this.mainSocketService = new SocketService();
        this.tradelayerService = new TradeLayerService();
    }

    get server() {
        return this._server;
    }

    start() {
        handleRoutes(this.server);
        this.mainSocketService.init(this.server);
        this.initWebSocketEvents(); // Initialize WebSocket event handling
        this.server.listen(this.port)
            .catch((error) => {
                console.error('Error starting server:', error);
                this.stop();
            });
    }

    async stop() {
        if (this.rpcClient) {
            try {
                const isConnectedRes = await this.rpcClient.call('getblockchaininfo');
                const isConnected = !!isConnectedRes.data;
                await this.tradelayerService.stop();
                if (isConnected) await this.rpcClient.call('stop');
                if (!isConnected) await killPort(this.rpcPort);
            } catch (error) {
                console.error('Error during stop:', error);
            }
        }

        this.safeStop();
        const safeExistInterval = setInterval(() => {
            if (this.rpcClient || this.rpcPort) return;
            clearInterval(safeExistInterval);
            this.safeStop();
        }, 500);
    }

    private safeStop() {
        if (this.rpcClient || this.rpcPort) return;
        this.clearOBSocketConnection();
        this.safeClose();
        this.clearMainSocketConnection();
    }

    initOBSocketConnection(options: IOBSocketServiceOptions) {
        this.clearOBSocketConnection();
        this.obSocketService = new OBSocketService(options);
    }

    clearMainSocketConnection() {
        if (this.mainSocketService?.currentSocket) {
            // Replace 'offAny()' with 'removeAllListeners()' if using EventEmitter
            this.mainSocketService.currentSocket.removeAllListeners?.(); // Optional chaining in case it's undefined
            // Replace 'disconnect()' with 'close()' or 'terminate()' based on WebSocket implementation
            if (typeof this.mainSocketService.currentSocket.close === 'function') {
                this.mainSocketService.currentSocket.close();
            } else if (typeof this.mainSocketService.currentSocket.terminate === 'function') {
                this.mainSocketService.currentSocket.terminate();
            } else {
                console.warn('Cannot close the mainSocketService.currentSocket: No close or terminate method found.');
            }
        }
        this.mainSocketService = null;
    }

    clearOBSocketConnection() {
        if (this.obSocketService?.socket) {
            // Replace 'offAny()' with 'removeAllListeners()' if using EventEmitter
            this.obSocketService.socket.removeAllListeners?.(); // Optional chaining in case it's undefined
            // Replace 'disconnect()' with 'close()' or 'terminate()' based on WebSocket implementation
            if (typeof this.obSocketService.socket.close === 'function') {
                this.obSocketService.socket.close();
            } else if (typeof this.obSocketService.socket.terminate === 'function') {
                this.obSocketService.socket.terminate();
            } else {
                console.warn('Cannot close the obSocketService.socket: No close or terminate method found.');
            }
        }
        this.obSocketService = null;
    }

    private initWebSocketEvents() {
        // Implement any additional WebSocket event initialization if needed
        console.log('WebSocket events initialized.');
    }
}
