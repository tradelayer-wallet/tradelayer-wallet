import { Socket, Server } from "socket.io";
import { SocketScript } from '../socket-script/socket-script';
import { FastifyInstance } from "fastify"
import { disconnectFromOrderbook, initApiService, initOrderbookConnection, orderbookSocketService } from ".";
import { TClient } from "../socket-script/common/types";

interface IContractInfo {
    contractName: string;
    contractId: number;
}

export class WalletSocketSevice {
    public io: Server;
    public currentSocket: Socket;
    private socketScript: SocketScript;
    public lastBlock: number = 0;
    private selectedContractId: IContractInfo = null;
    private blockCountingInterval: any;

    constructor(app: FastifyInstance, socketScript: SocketScript) {
        const socketOptions = { cors: { origin: "*", methods: ["GET", "POST"] } };
        this.io = new Server(app.server, socketOptions);
        this.socketScript = socketScript;
        this.handleEvents()
    }

    private handleEvents() {
        this.io.on('connection', this.onConnection.bind(this));
    }

    private onConnection(socket: Socket) {
        this.currentSocket = socket;
        this.handleFromWalletToServer(socket, 'orderbook-market-filter');
        this.handleFromWalletToServer(socket, 'update-orderbook');
        this.handleFromWalletToServer(socket, 'dealer-data');
        this.handleFromWalletToServer(socket, 'close-position');
        this.handleFromWalletToServer(socket, 'logout');

        this.handleFromWalletToServer(socket, 'orderbook-market-filter-futures');
        this.handleFromWalletToServer(socket, 'update-orderbook-futures');
        this.handleFromWalletToServer(socket, 'close-position-futures');

        socket.on('api-reconnect', (url: string) => initOrderbookConnection(this.socketScript, url));
        socket.on('orderbook-disconnect', () => disconnectFromOrderbook());

        socket.on('api-2-reconnect', (isTestNet: boolean) => initApiService(isTestNet));

        // socket.on('update-futures-orderbook', this.sendFuturesOrderbookData.bind(this));
        // socket.on('orderbook-contract-filter', (contract: IContractInfo) => {
        //     this.selectedContractId = contract;
        //     this.sendFuturesOrderbookData();
        // });
    }

    // private async sendFuturesOrderbookData() {
    //     if (!this.selectedContractId) return;
    //     this.currentSocket.emit('futures-orderbook-data', await getFuturesOrderBookData(this.selectedContractId, this.socketScript.asyncClient));
    // }

    private handleFromWalletToServer(socket: Socket, eventName: string) {
        socket.on(eventName, (data: any) => orderbookSocketService.socket.emit(eventName, data));
    }

    stopBlockCounting() {
        if (this.blockCountingInterval) {
            clearInterval(this.blockCountingInterval);
            this.blockCountingInterval = null;
        }
    }

    startBlockCounting() {
        if (this.blockCountingInterval) return;
        this.blockCountingInterval = setInterval(async () => {
            const { asyncClient } = this.socketScript;
            if (!asyncClient) return;
            const bbhRes = await asyncClient('getbestblockhash');
            if (bbhRes.error || !bbhRes.data) {
                this.onTimeOutMessage(bbhRes.error);
                return null;
            }
            const bbRes = await asyncClient('getblock', bbhRes.data);
            if (bbRes.error || !bbRes.data) {
                this.onTimeOutMessage(bbhRes.error);
                return null;
            };
            const height = bbRes.data.height;
            if (this.lastBlock < height) {
                this.lastBlock = height;
                this.currentSocket.emit('newBlock', height);
                // this.sendFuturesOrderbookData();
            }
        }, 2500);
    }

    async onTimeOutMessage(message: string) {
        if (message && message.includes('ECONNREFUSED')) {
            const { asyncClient } = this.socketScript;
            const check = await asyncClient('tl_getinfo');
            if (check.error || !check.data) {
                this.currentSocket.emit('rpc-connection-error');
                this.socketScript.clearConnection();
            }
        }
    }
}

// const getFuturesOrderBookData = async (contract: IContractInfo, asyncClient: TClient) => {
//     const { contractName } = contract;
//     const buyOrderbooksRes = await asyncClient('tl_getcontract_orderbook', contractName, 1);
//     const sellOrderbooksRes = await asyncClient('tl_getcontract_orderbook', contractName, 2);
//     const convertData = (d: any) => ({ contractId: d.contractid, price: parseFloat(d.effectiveprice), amount: d.amountforsale })
//     const buyOrderbook = (buyOrderbooksRes.error || !buyOrderbooksRes.data) ? [] : buyOrderbooksRes.data.map(convertData)
//     const sellOrderbook = (sellOrderbooksRes.error || !sellOrderbooksRes.data) ? [] : sellOrderbooksRes.data.map(convertData);
//     const orderbookObject = { buyOrderbook, sellOrderbook };
//     return orderbookObject;
// }