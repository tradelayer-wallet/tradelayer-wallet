import { Client } from 'litecoin'
import { ListenerServer } from './listener';
import { asyncClient } from './common/async-client';
import { ApiRes, IRPCConenction, TClient } from './common/types';
import { Socket } from 'socket.io-client';

export class SocketScript {
    private _ltcClient: any;
    private _listener: ListenerServer;
    private _asyncClient: TClient;
    constructor() {}

    get ltcClient() {
        return this._ltcClient;
    }

    private set ltcClient(value: any) {
        this._ltcClient = value;
    }

    private get listener() {
        return this._listener;
    }

    private set listener(value: ListenerServer) {
        this._listener = value;
    }

    get asyncClient() {
        return this._asyncClient;
    }

    set asyncClient(value: TClient) {
        this._asyncClient = value;
    }

    connect(rpcConnection: IRPCConenction): Promise<boolean> {
        return new Promise(async (res, rej) => {
            const { user, pass, host, port, ssl, timeout } = rpcConnection;
            this.ltcClient = new Client({
                user: user,
                pass: pass,
                host: host || 'localhost',
                port: port || 9332,
                ssl: ssl ||  false,
                timeout: timeout || 3000,
            });
            const newAsyncClent: TClient = asyncClient(this.ltcClient);
            const checkRes = await newAsyncClent("tl_getinfo");
            const { data, error } = checkRes;
            if (!error && data?.['block']) {
                console.log(`Socket Script is Connected to the RPC`);
                this.asyncClient = newAsyncClent;
                res(true);
            } else {
                console.log(`There is an Error with RPC connection`);
                this.ltcClient = null;
                res(false);
            }
        });
    }

    channelSwap(socket: Socket, trade: any) {
        const { 
            price, amount, propIdDesired, propIdForSale, 
            buyerAddress, buyerPubKey, buyerSocketId,
            sellerAddress, sellerPubKey, sellerSocketId, 
            buyer
        } = trade;
        const tradeInfo = { price, amount, propIdDesired, propIdForSale };
        const buyerObj = { address: buyerAddress, pubKey: buyerPubKey, socketId: buyerSocketId };
        const sellerObj = { address: sellerAddress, pubKey: sellerPubKey, socketId: sellerSocketId };
        buyer
            ? new Buyer(tradeInfo, buyerObj, sellerObj, this.asyncClient, socket)
            : new Seller(tradeInfo, sellerObj, buyerObj, this.asyncClient, socket)
    }
}

class Buyer {
    constructor(
        private tradeInfo: ITradeInfo, 
        private myInfo: TBuyerSellerInfo, 
        private cpInfo: TBuyerSellerInfo,
        private asyncClient: TClient,
        private socket: Socket,
    ) { }

    private terminateTrade(reason: string = 'No info'): void {
        this.socket.emit('TERMINATE_TRADE', reason);
    }
}

class Seller {
    private multySigChannelData: MSChannelData;
    constructor(
        private tradeInfo: ITradeInfo, 
        private myInfo: TBuyerSellerInfo, 
        private cpInfo: TBuyerSellerInfo,
        private asyncClient: TClient,
        private socket: Socket,
    ) { 
        this.initTrade()
    } 

    private terminateTrade(reason: string = 'No info'): void {
        this.socket.emit('TERMINATE_TRADE', reason);
    }

    private async initTrade() {
        const pubKeys = [this.myInfo.pubKey, this.cpInfo.pubKey];
        const amaRes: ApiRes = await this.asyncClient("addmultisigaddress", 2, pubKeys);
        if (amaRes.error || !amaRes.data) return this.terminateTrade(amaRes.error);
        this.multySigChannelData = amaRes.data;

        const validateMS = await this.asyncClient("validateaddress", this.multySigChannelData.address);
        if (validateMS.error || !validateMS.data?.scriptPubKey) return this.terminateTrade(validateMS.error);
        this.multySigChannelData.scriptPubKey = validateMS.data.scriptPubKey;
        this.socket.emit('SELLER:MS_DATA', this.multySigChannelData);
    }
}

interface MSChannelData {
    address: string;
    redeemScript: string;
    scriptPubKey?: string;
}
interface ITradeInfo {
    price: number;
    amount: number;
    propIdDesired: number;
    propIdForSale: number;
}

interface TBuyerSellerInfo {
    address: string;
    pubKey: string;
    socketId: string;
}
