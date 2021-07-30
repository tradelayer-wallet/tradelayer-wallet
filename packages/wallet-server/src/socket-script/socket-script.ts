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
            amountDesired, amountForSale, propIdDesired, propIdForSale, 
            buyerAddress, buyerPubKey, buyerSocketId,
            sellerAddress, sellerPubKey, sellerSocketId, 
            buyer
        } = trade;
        const tradeInfo: ITradeInfo = { amountDesired, amountForSale, propIdDesired, propIdForSale };
        const buyerObj = { address: buyerAddress, pubKey: buyerPubKey, socketId: buyerSocketId };
        const sellerObj = { address: sellerAddress, pubKey: sellerPubKey, socketId: sellerSocketId };
        buyer
            ? new Buyer(tradeInfo, buyerObj, sellerObj, this.asyncClient, socket)
            : new Seller(tradeInfo, sellerObj, buyerObj, this.asyncClient, socket)
    }
}

class Buyer {
    private multySigChannelData: MSChannelData;

    constructor(
        private tradeInfo: ITradeInfo, 
        private myInfo: TBuyerSellerInfo, 
        private cpInfo: TBuyerSellerInfo,
        private asyncClient: TClient,
        private socket: Socket,
    ) { 
        console.log(`Buyer started`);
        this.handleOnEvents();
    }

    private terminateTrade(reason: string = 'No info'): void {
        this.socket.emit('TERMINATE_TRADE', reason);
    }

    private handleOnEvents() {
        this.socket.on('SELLER:MS_DATA', this.onMSData.bind(this));
        this.socket.on('COMMIT_UTXO', this.onCommitUTXO.bind(this));
        this.socket.on('SELLER:SIGNED_RAWTX', this.onSignedRawTx.bind(this));

    }
    
    private async onMSData(cpId: string, msData: MSChannelData) {
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 1');


        const pubKeys = [this.cpInfo.pubKey, this.myInfo.pubKey];
        const amaRes: ApiRes = await this.asyncClient("addmultisigaddress", 2, pubKeys);
        if (amaRes.error || !amaRes.data) return this.terminateTrade(amaRes.error);
        if (amaRes.data.redeemScript !== msData.redeemScript) return this.terminateTrade(`redeemScript of Multysig address is not matching`);
        this.multySigChannelData = msData;
        this.socket.emit('BUYER:COMMIT');
    }

    private async onCommitUTXO(cpId: string, commitUTXO: IUTXOData) {
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 1');
        const rawHex = await this.buildLTCInstantTrade(commitUTXO);
        if (rawHex.error || !rawHex.data) return this.terminateTrade(rawHex.error || `Error with Buildng Trade`);
        this.socket.emit('BUYER:RAWTX', rawHex.data);
    }

    private onSignedRawTx(cpId: string, rawTx: string) {
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 1');
        if (!rawTx) return this.terminateTrade('RawTx Not Provided');
        console.log({rawTx});
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
    
            const vins = [txid, ...clientVins.data];
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
                if (crtxiRes.error || !crtxiRes.data) return { error: 'Error with creating raw tx' };
                hex = crtxiRes.data;
            }
            return { data: hex };
        };
        const crtxiRes: any = await tl_createrawtx_inputAll();
        if (crtxiRes.error || !crtxiRes.data) return { error: 'Error with creating raw tx' };

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
        const lusRes = await this.asyncClient('listunspent', 0, 999999999, [this.cpInfo.address]);
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

    constructor(
        private tradeInfo: ITradeInfo, 
        private myInfo: TBuyerSellerInfo, 
        private cpInfo: TBuyerSellerInfo,
        private asyncClient: TClient,
        private socket: Socket,
    ) { 
        this.handleOnEvents();
        this.initTrade();
    } 

    private terminateTrade(reason: string = 'No info'): void {
        this.socket.emit('TERMINATE_TRADE', reason);
    }

    private handleOnEvents() {
        this.socket.on('BUYER:COMMIT', this.onCommit.bind(this));
        this.socket.on('BUYER:RAWTX', this.onRawTx.bind(this))
    }

    private async initTrade() {
        if (this.tradeInfo.propIdForSale !== 999) return this.terminateTrade('The wallet dont Support this type of trade!');
        const pubKeys = [this.myInfo.pubKey, this.cpInfo.pubKey];
        const amaRes: ApiRes = await this.asyncClient("addmultisigaddress", 2, pubKeys);
        if (amaRes.error || !amaRes.data) return this.terminateTrade(amaRes.error);
        this.multySigChannelData = amaRes.data;

        const validateMS = await this.asyncClient("validateaddress", this.multySigChannelData.address);
        if (validateMS.error || !validateMS.data?.scriptPubKey) return this.terminateTrade(validateMS.error);
        this.multySigChannelData.scriptPubKey = validateMS.data.scriptPubKey;
        this.socket.emit('SELLER:MS_DATA', this.multySigChannelData);
    }

    private async onCommit(cpId: string) {
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 1');
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
        this.socket.emit('SELLER:COMMIT_UTXO', this.utxoData);
    }

    private async onRawTx(cpId: string, rawTx: string) {
        if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Error with p2p connection: code 1');
        if (!rawTx) return this.terminateTrade('No RawTx for Signing Provided!');

        const { txid, vout, amount } = this.utxoData;
        const { scriptPubKey, redeemScript } = this.multySigChannelData;

        if (!txid || !vout || !amount || !scriptPubKey || !redeemScript) {
            this.terminateTrade('Error with saved Data');
            return;
        }
        const prevTxsData = { txid, vout, amount, scriptPubKey, redeemScript };
        const ssrtxRes = await this.asyncClient("signrawtransaction", rawTx, [prevTxsData]);
        if (ssrtxRes.error || !ssrtxRes.data?.hex) return this.terminateTrade(ssrtxRes.error || `Error with Signing Raw TX`);
        this.socket.emit('SELLER:SIGNED_RAWTX', ssrtxRes.data?.hex);
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
