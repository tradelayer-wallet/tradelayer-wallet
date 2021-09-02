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
                if (error === 'Loading wallet...' || error === 'Loading block index...' || error === 'Rewinding blocks...') {
                    this.asyncClient = newAsyncClent;
                    res(true);
                } else {
                    this.clearConnection();
                    res(false);
                }
            }
        });
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
            console.log({res});
        return res;
    }

    // clearConnection() {
    //     this.ltcClient = null;
    //     this.asyncClient = null;
    // }
}

class Buyer {
    private multySigChannelData: MSChannelData;
    private readyRes: (value: { data?: any, error?: any }) => void;


    constructor(
        private tradeInfo: ITradeInfo, 
        private myInfo: TBuyerSellerInfo, 
        private cpInfo: TBuyerSellerInfo,
        private asyncClient: TClient,
        private socket: Socket,
    ) { 
        this.handleOnEvents();
        this.onReady();
    }

    onReady() {
        return new Promise<{ data?: any, error?: any }>((res) => {
            this.readyRes = res;
        });
    }

    private terminateTrade(reason: string = 'No info'): void {
        this.socket.emit(`${this.myInfo.socketId}::TERMINATE_TRADE`, reason);
        this.onTerminateTrade('', reason);
    }

    private removePreviuesListeners() {
        const eventsArray = ['TERMINATE_TRADE', 'SELLER:MS_DATA', 'SELLER:COMMIT_UTXO', 'SELLER:SIGNED_RAWTX'];
        eventsArray.forEach(e => this.socket.off(`${this.cpInfo.socketId}::${e}`));
    }

    private handleOnEvents() {
        this.removePreviuesListeners();

        this.socket.on(`${this.cpInfo.socketId}::TERMINATE_TRADE`, this.onTerminateTrade.bind(this));
        this.socket.on(`${this.cpInfo.socketId}::SELLER:MS_DATA`, this.onMSData.bind(this));
        this.socket.on(`${this.cpInfo.socketId}::SELLER:COMMIT_UTXO`, this.onCommitUTXO.bind(this));
        this.socket.on(`${this.cpInfo.socketId}::SELLER:SIGNED_RAWTX`, this.onSignedRawTx.bind(this));
    }
    
    private onTerminateTrade(cpId: string, reason: string = 'Undefined Reason') {
        console.log(`ONTRADE TERMINATED! REASON: ${reason}`);
        if (this.readyRes) this.readyRes({ error: reason });
        this.removePreviuesListeners();
    }

    private async onMSData(cpId: string, msData: MSChannelData) {
        console.log(`MultySigData from ${cpId}`);
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 2');
        const pubKeys = [this.cpInfo.pubKey, this.myInfo.pubKey];
        const amaRes: ApiRes = await this.asyncClient("addmultisigaddress", 2, pubKeys);
        if (amaRes.error || !amaRes.data) return this.terminateTrade(amaRes.error);
        if (amaRes.data.redeemScript !== msData.redeemScript) return this.terminateTrade(`redeemScript of Multysig address is not matching`);
        this.multySigChannelData = msData;
        this.socket.emit(`${this.myInfo.socketId}::BUYER:COMMIT`);
    }

    private async onCommitUTXO(cpId: string, commitUTXO: IUTXOData) {
        console.log(`commitUTXO from ${cpId}`);
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 3');
        const rawHex = await this.buildLTCInstantTrade(commitUTXO);
        if (rawHex.error || !rawHex.data) return this.terminateTrade(rawHex.error || `Error with Buildng Trade`);
        this.socket.emit(`${this.myInfo.socketId}::BUYER:RAWTX`, rawHex.data);
    }

    private async onSignedRawTx(cpId: string, rawTxObj: { hex: string, prevTxsData: any }) {
        const { hex, prevTxsData } = rawTxObj;
        console.log(`SignedRawTx from ${cpId}`);
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 4');
        if (!hex) return this.terminateTrade('RawTx Not Provided');
        const ssrtxRes = await this.asyncClient("signrawtransaction", hex, [prevTxsData]);
        // const ssrtxRes = await this.asyncClient("signrawtransaction", hex);
        if (ssrtxRes.error || !ssrtxRes.data?.hex || !ssrtxRes.data?.complete) return this.terminateTrade(ssrtxRes.error || `Error with Signing Raw TX`);
        const finalTxId = await this.sendRawTransaction(ssrtxRes.data.hex);
        if (this.readyRes) this.readyRes({ data: { txid: finalTxId, seller: false, trade: this.tradeInfo } });
        this.socket.emit(`${this.myInfo.socketId}::BUYER:FINALTX`, finalTxId);
        this.removePreviuesListeners();
    }

    private async sendRawTransaction(hex: string) {
        await new Promise(res => setTimeout(() => res(true), 250));
        const result = await this.asyncClient("sendrawtransaction", hex);
        if (result.error || !result.data) return await this.sendRawTransaction(hex);
        return result.data;
    }

    private async buildLTCInstantTrade(commitUTXO: IUTXOData) {
        try {
            const { vout, amount, txid } = commitUTXO;
            if (!vout || !amount || !txid)  return { error: 'Error Provided Commit Data' };
    
            const bbData: number = await this.getBestBlock(10);
            if (!bbData) return { error: `Error with getting best block, ${bbData}` };
    
            const { propIdDesired, amountDesired, amountForSale } = this.tradeInfo;
            const cpitLTCOptions = [ propIdDesired, amountDesired, amountForSale, bbData ];
            const cpitRes = await this.asyncClient('tl_createpayload_instant_ltc_trade', ...cpitLTCOptions);
            if (cpitRes.error || !cpitRes.data) return { error: cpitRes.error || `Error with creating payload` };
    
            const clientVins = await this.getUnspentsForFunding(amountForSale);
            if (clientVins.error || !clientVins.data?.length) return { error: cpitRes.error || `Error with finding enough LTC for ${this.myInfo.address}` }
    
            const vins = [commitUTXO, ...clientVins.data];
            const bLTCit = await this._buildLTCInstantTrade(vins, cpitRes.data, this.myInfo.address, amountForSale, this.cpInfo.address);
            if (bLTCit.error || !bLTCit.data) return { error: bLTCit.error || `Error with Building LTC Instat Trade` };
            return { data: bLTCit.data };
        } catch (error) {
            return { error: error.message }
        }
    }

    private async _buildLTCInstantTrade(
        vins: any[],
        payload: string,
        changeAddress: string,
        price: string,
        refAddress: string,
    ): Promise<{ data?: any[], error?: any }> {
        if (!vins?.length || !payload || !refAddress || !price || !changeAddress) return { error: 'Missing argumetns for building LTC Instant Trade' };

        const sumVinsAmount = vins.map(vin => vin.amount).reduce((a, b) => a + b, 0);
        if (sumVinsAmount < parseFloat(price)) return { error: 'Error with vins' };
        const tl_createrawtx_inputAll = async () => {
            let hex = '';
            for (const vin of vins) {
                const crtxiRes: any = await this.asyncClient('tl_createrawtx_input', hex, vin.txid, vin.vout);
                if (crtxiRes.error || !crtxiRes.data) return { error: 'Error with creating raw tx: code 1' };
                hex = crtxiRes.data;
            }
            return { data: hex };
        };
        const crtxiRes: any = await tl_createrawtx_inputAll();
        if (crtxiRes.error || !crtxiRes.data) return { error: 'Error with creating raw tx: code 2' };

        const change = (sumVinsAmount - (parseFloat(price) + 0.0005)).toFixed(4);
        const _crtxrRes: any = await this.asyncClient('tl_createrawtx_reference', crtxiRes.data, changeAddress, change);
        if (_crtxrRes.error || !_crtxrRes.data) return { error: _crtxrRes.error || 'Error with adding referance address' };
    
        const crtxrRes: any = await this.asyncClient('tl_createrawtx_reference', _crtxrRes.data, refAddress, price);
        if (crtxrRes.error || !crtxrRes.data) return { error: crtxrRes.error || 'Error with adding referance address' };
    
        const crtxoRes: any = await this.asyncClient('tl_createrawtx_opreturn', crtxrRes.data, payload);
        if (crtxoRes.error || !crtxoRes.data) return { error: 'Error with adding payload' };
        return crtxoRes;
    }

    private async getUnspentsForFunding(amount: string): Promise<{ data?: any[], error?: any }> {
        const lusRes = await this.asyncClient('listunspent', 0, 999999999, [this.myInfo.address]);
        if (lusRes.error || !lusRes.data?.length) {
          return lusRes
        } else {
          let res: any[] = [];
          lusRes.data.forEach((u: any) => {
            const amountSum = res.map(r => r.amount).reduce((a, b) => a + b, 0);
            if (amountSum < (parseFloat(amount) + 0.1)) res.push(u);
          });
          return { data: res.map(u => ({vout: u.vout, txid: u.txid, amount: u.amount})) };
        }
    }

    private async getBestBlock(n: number) {
        const bbhRes = await this.asyncClient('getbestblockhash');
        if (bbhRes.error || !bbhRes.data) return null;
        const bbRes = await this.asyncClient('getblock', bbhRes.data);
        if (bbRes.error || !bbRes.data?.height) return null;
        const height = bbRes.data.height + n;
        return height;
    }
}
class Seller {
    private multySigChannelData: MSChannelData;
    private commitTx: string;
    private utxoData: IUTXOData;
    private readyRes: (value: { data?: any, error?: any }) => void;


    constructor(
        private tradeInfo: ITradeInfo, 
        private myInfo: TBuyerSellerInfo, 
        private cpInfo: TBuyerSellerInfo,
        private asyncClient: TClient,
        private socket: Socket,
    ) { 
        this.handleOnEvents();
        this.initTrade();
        this.onReady();
    } 

    onReady() {
        return new Promise<{ data?: any, error?: any }>((res) => {
            this.readyRes = res;
        });
    }

    private terminateTrade(reason: string = 'No info'): void {
        this.socket.emit(`${this.myInfo.socketId}::TERMINATE_TRADE`, reason);
        this.onTerminateTrade('', reason);
    }

    private removePreviuesListeners() {
        const eventsArray = ['TERMINATE_TRADE', 'BUYER:COMMIT', 'BUYER:RAWTX', 'BUYER:FINALTX' ];
        eventsArray.forEach(e => this.socket.off(`${this.cpInfo.socketId}::${e}`));
    }

    private handleOnEvents() {
        this.removePreviuesListeners();
        this.socket.on(`${this.cpInfo.socketId}::TERMINATE_TRADE`, this.onTerminateTrade.bind(this));
        this.socket.on(`${this.cpInfo.socketId}::BUYER:COMMIT`, this.onCommit.bind(this));
        this.socket.on(`${this.cpInfo.socketId}::BUYER:RAWTX`, this.onRawTx.bind(this));
        this.socket.on(`${this.cpInfo.socketId}::BUYER:FINALTX`, this.onFinalTx.bind(this));
    }

    private async initTrade() {
        console.log(`InitTrade!`);
        if (this.tradeInfo.propIdForSale !== 999) return this.terminateTrade('The wallet dont Support this type of trade!');
        const pubKeys = [this.myInfo.pubKey, this.cpInfo.pubKey];
        const amaRes: ApiRes = await this.asyncClient("addmultisigaddress", 2, pubKeys);
        if (amaRes.error || !amaRes.data) return this.terminateTrade(amaRes.error);
        this.multySigChannelData = amaRes.data;

        const validateMS = await this.asyncClient("validateaddress", this.multySigChannelData.address);
        if (validateMS.error || !validateMS.data?.scriptPubKey) return this.terminateTrade(validateMS.error);
        this.multySigChannelData.scriptPubKey = validateMS.data.scriptPubKey;
        this.socket.emit(`${this.myInfo.socketId}::SELLER:MS_DATA`, this.multySigChannelData);
    }

    private onTerminateTrade(cpId: string, reason: string = 'Undefined Reason') {
        console.log(`TRADE TERMINATED! REASON: ${reason}`);
        if (this.readyRes) this.readyRes({ error: reason });
        this.removePreviuesListeners();
    }

    private async onCommit(cpId: string) {
        console.log(`OnCommit from ${cpId}`);
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 6');
        if (this.tradeInfo.propIdForSale !== 999) return this.terminateTrade('The wallet dont Support this type of trade!');

        const commitData = [        
            this.myInfo.address,
            this.multySigChannelData.address,
            this.tradeInfo.propIdDesired,
            this.tradeInfo.amountDesired,
        ];
        const ctcRes = await this.asyncClient("tl_commit_tochannel", ...commitData);
        if (ctcRes.error || !ctcRes.data) return this.terminateTrade(ctcRes.error);
        this.commitTx = ctcRes.data;

        const gtRes = await this.asyncClient("gettransaction", this.commitTx);
        if (gtRes.error || !gtRes.data?.hex) return this.terminateTrade(gtRes.error);
        const drtRes = await this.asyncClient("decoderawtransaction", gtRes.data.hex);
        if (drtRes.error || !drtRes.data?.vout) return this.terminateTrade(drtRes.error);
        const vout = drtRes.data.vout.find((o: any) => o.scriptPubKey?.addresses?.[0] === this.multySigChannelData.address);
        if (!vout) return this.terminateTrade(drtRes.error);
        this.utxoData = {
            amount: vout.value,
            vout: vout.n,
            txid: this.commitTx
        };
        this.socket.emit(`${this.myInfo.socketId}::SELLER:COMMIT_UTXO`, this.utxoData);
    }

    private async onRawTx(cpId: string, rawTx: string) {
        console.log(`OnRawTx form ${cpId}`);
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 7');
        if (!rawTx) return this.terminateTrade('No RawTx for Signing Provided!');

        const { txid, vout, amount } = this.utxoData;
        const { scriptPubKey, redeemScript } = this.multySigChannelData;

        if (!txid || !vout || !amount || !scriptPubKey || !redeemScript) {
            this.terminateTrade('Error with saved Data');
            return;
        }
        const prevTxsData = { txid, vout, amount, scriptPubKey, redeemScript };
        const ssrtxRes = await this.asyncClient("signrawtransaction", rawTx, [prevTxsData]);
        console.log(2)
        console.log({ssrtxRes, error: ssrtxRes.data.errors })
        if (ssrtxRes.error || !ssrtxRes.data?.hex) return this.terminateTrade(ssrtxRes.error || `Error with Signing Raw TX`);
        this.socket.emit(`${this.myInfo.socketId}::SELLER:SIGNED_RAWTX`, { hex: ssrtxRes.data.hex, prevTxsData });
    }

    private async onFinalTx(cpId: string, finalTx: string) {
        console.log({finalTx})
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 6');
        if (this.readyRes) this.readyRes({ data: { txid: finalTx, seller: true, trade: this.tradeInfo } });
        this.removePreviuesListeners();
    }
}

interface MSChannelData {
    address: string;
    redeemScript: string;
    scriptPubKey?: string;
}
interface ITradeInfo {
    amountDesired: string;
    amountForSale: string;
    propIdDesired: number;
    propIdForSale: number;
}

interface TBuyerSellerInfo {
    address: string;
    pubKey: string;
    socketId: string;
}

interface IUTXOData {
    amount: number,
    vout: number,
    txid: string,
}
