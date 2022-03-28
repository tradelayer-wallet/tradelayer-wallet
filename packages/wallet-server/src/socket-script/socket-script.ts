import { Client } from 'litecoin'
import { ListenerServer } from './listener';
import { asyncClient } from './common/async-client';
import { IBuildRawTxOptions, IContractTradeInfo, IRPCConenction, ITradeInfo, TClient } from './common/types';
import { Socket } from 'socket.io-client';
import { Buyer } from './common/buyer';
import { Seller } from './common/seller';
import { RawTx } from './common/rawtx';
import { customLogger } from './common/logger';
import { orderbookSocketService } from '../sockets';
import { getDataDefaultStrategy } from './liquidity-provider/default-strategy';

export class SocketScript {
    private _ltcClient: any;
    private _listener: ListenerServer;
    private _asyncClient: TClient;
    private isLiquidityStarted: boolean = false;
    private liqOptions: any;
    private countLiquidityRefills: number = 0;
    private liqTimeOut: any;

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
                this.asyncClient = newAsyncClent;
                res(true);
            } else {
                if (error.includes('ECONNREFUSED') || error.includes('401')) {
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
        customLogger(`Init New withdraw: ${JSON.stringify({fromAddress, toAddress, amount})}`);
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
        customLogger(`End withdraw: ${JSON.stringify(sendedRawTx)}`);
        return { data: sendedRawTx.data };
    }

    async channelSwap(socket: Socket, trade: any) {
        customLogger(`Init New Trade: ${JSON.stringify(trade)}`);
        const { 
            amountDesired, amountForSale, propIdDesired, propIdForSale, 
            buyerAddress, buyerPubKey, buyerSocketId,
            sellerAddress, sellerPubKey, sellerSocketId, 
            buyer, contractId, amount, price,
        } = trade;

        const tradeInfo: ITradeInfo | IContractTradeInfo = contractId
            ? { amount, price, contractId }
            : { amountDesired, amountForSale, propIdDesired, propIdForSale };
        process.send({tradeInfo});
        const buyerObj = { address: buyerAddress, pubKey: buyerPubKey, socketId: buyerSocketId };
        const sellerObj = { address: sellerAddress, pubKey: sellerPubKey, socketId: sellerSocketId };
        const swap = buyer
            ? new Buyer(tradeInfo, buyerObj, sellerObj, this.asyncClient, socket)
            : new Seller(tradeInfo, sellerObj, buyerObj, this.asyncClient, socket);
        const res = await swap.onReady();
        process.send({res});
        if (res.data?.txid) {
            if (this.liqOptions?.address === trade.sellerAddress || this.liqOptions?.address === trade.buyerAddress) {
                this.liquidityRefill();
            }
        }
        customLogger(`End Trade: ${JSON.stringify(res)}`);
        return res;
    }

    liquidityRefill() {
        if (this.liqTimeOut) {
            clearTimeout(this.liqTimeOut);
            this.liqTimeOut = null;
        }
        if (!this.isLiquidityStarted || this.countLiquidityRefills >= 3) return;
        if (this.liqOptions) {
            this.liqTimeOut = setTimeout(() => {
                this.countLiquidityRefills++;
                this.stopLiquidityScript(this.liqOptions, true)
                this.runLiquidityScript(this.liqOptions)
    
            }, 30000);
        }
    }

    async runLiquidityScript(options: any) {
        try {
            if (!this.liqOptions) this.liqOptions = options;
            if (this.isLiquidityStarted) orderbookSocketService.socket.emit('clean-by-address', options.address);
            this.isLiquidityStarted = true;
            const { address } = options;
            const balanceLTCRes = await this.asyncClient('listunspent', 0, 999999999, [address]);
            if (balanceLTCRes.error || !balanceLTCRes.data) return { error: balanceLTCRes.error || `Error with getting ${address} LTC balance` };
            const _balanceLTC = balanceLTCRes.data
                .map((e: any) => parseFloat(e.amount))
                .reduce((a: number, b: number) => a + b, 0);
            const balanceTokensRes = await this.asyncClient('tl_getbalance', address, 4);
            if (balanceTokensRes.error || !balanceTokensRes.data) return { error: balanceTokensRes.error || `Error with getting ${address} ALL balance` };

            const balanceTokens = parseFloat(balanceTokensRes.data.balance);
            const balanceLTC = parseFloat(_balanceLTC.toFixed(6));
            const data = getDataDefaultStrategy(options, balanceLTC, balanceTokens);
            this.addManyOrders(data);
            return { data: true };
        } catch (err) {
            return { error: err.message };
        }
    }

    async stopLiquidityScript(address: string, refill: boolean = false) {
        try {
            if (this.isLiquidityStarted) orderbookSocketService.socket.emit('clean-by-address', address);
            if (!refill) {
                this.isLiquidityStarted = false;
                this.countLiquidityRefills = 0;
                this.liqOptions = null;
            }
            return { data: true };
        } catch (err) {
            return { error: err.message };
        }
    }

    private async addManyOrders(data: any[]) {
        if (this.isLiquidityStarted) orderbookSocketService.socket.emit('add-many', data);
    }
}
