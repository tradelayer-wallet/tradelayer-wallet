import { Client } from 'litecoin'
import { ListenerServer } from './listener';
import { asyncClient } from './common/async-client';
import { IBuildRawTxOptions, IRPCConenction, ITradeInfo, TClient } from './common/types';
import { Socket } from 'socket.io-client';
import { Buyer } from './common/buyer';
import { Seller } from './common/seller';
import { RawTx } from './common/rawtx';

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

    clearConnection() {
        this.asyncClient = null;
        this.ltcClient = null;
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
            if (!error && data?.['blocktime']) {
                console.log(`Socket Script is Connected to the RPC`);
                this.asyncClient = newAsyncClent;
                res(true);
            } else {
                if (error.includes('ECONNREFUSED')) {
                    this.clearConnection();
                    res(false);
                } else {
                    this.asyncClient = newAsyncClent;
                    res(true);
                }
            }
        });
    }

    async withdraw(fromAddress: string, toAddress: string, amount: string) {
        const options: IBuildRawTxOptions = { fromAddress, toAddress, refAddressAmount: parseFloat(amount) };
        const rawTx = new RawTx(options, this.asyncClient);
        const hexRes = await rawTx.build();
        const hexErrorMessage = `Error with building the transaction`;
        if (hexRes.error || !hexRes.data) return { error: hexRes.error || hexErrorMessage };

        const signedRawTx = await rawTx.signRawTx();
        const signingErrorMessage = `Error with Signing the transaction`;
        if (signedRawTx.error || !signedRawTx.data) return { error: signedRawTx.error || signingErrorMessage };

        const sendedRawTx = await rawTx.sendrawTx();
        const sendingErrorMessage = `Error with Sending the transaction`;
        if (sendedRawTx.error || !sendedRawTx.data) return { error: sendedRawTx.error || sendingErrorMessage };
        return { data: sendedRawTx.data };
    }

    async channelSwap(socket: Socket, trade: any) {
        const { 
            amountDesired, amountForSale, propIdDesired, propIdForSale, 
            buyerAddress, buyerPubKey, buyerSocketId,
            sellerAddress, sellerPubKey, sellerSocketId, 
            buyer
        } = trade;
        const tradeInfo: ITradeInfo = { amountDesired, amountForSale, propIdDesired, propIdForSale };
        const buyerObj = { address: buyerAddress, pubKey: buyerPubKey, socketId: buyerSocketId };
        const sellerObj = { address: sellerAddress, pubKey: sellerPubKey, socketId: sellerSocketId };
        const swap = buyer
            ? new Buyer(tradeInfo, buyerObj, sellerObj, this.asyncClient, socket)
            : new Seller(tradeInfo, sellerObj, buyerObj, this.asyncClient, socket);
            const res = await swap.onReady();
        return res;
    }
}
