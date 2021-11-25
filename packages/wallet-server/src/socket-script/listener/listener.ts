import { Socket } from "socket.io";
import {
  TClient,
  Trade,
  Events1 as onEvents,
  Events2 as emitEvents,
  ApiRes,
  TradeTypes,
  TTTOptions,
  LITOptions,
} from "../common/types";

export class Listener {
    private socket: Socket;
    private client: TClient;

    private logs: boolean = false;
    private trade: Trade;

    private listenerAddress: string;
    private receiverAddress: string;

    private listenerPubKey: string;
    private receiverPubKey: string;
    private multySigChannelData: any;

    private comId: number;
    private comAmount: number;

    private listenerCommitTx: string;
    private utxoData: any;

    constructor(socket: Socket, address: string, pubkey: string, client: TClient, logs: boolean) {
      this.socket = socket,
      this.listenerAddress = address;
      this.listenerPubKey = pubkey;
      this.client = client;
      this.logs = logs;
      this.init();
    }

    close(): void {
        this.log(`Disconnected Socket: ID ${this.socket.id}`);
        this.socket.disconnect();
    }

    private terminateTrade(reason: string = 'No info'): void {
      this.log(`Trade Terminated! ${reason}`);
      this.socket.emit(emitEvents.TERMINATE_TRADE, reason);
      this.close();
    }

    private init(): void {
        this.log(`New Socket Connection: ID ${this.socket.id}`);
        this.handleListeners();
      }

    private log(message: string, data?: any): void {
    }

    private handleListeners(): void {
      this.socket.on(onEvents.TRADE_REQUEST, this.onTradeRequest.bind(this));
      this.socket.on(onEvents.COMMIT_TO_CHANNEL, this.onCommitToChannel.bind(this));
      this.socket.on(onEvents.RAWTX_FOR_SIGNING, this.onRawTxForSigning.bind(this));
    }

    private onTradeRequest(trade: Trade): void {
      this.log(`Trade Request:`, trade);
      this.trade = trade;
      const isValid = true;
      isValid ? this.initNewTrade(trade) : this.rejectTrade('Bad Trade');
    }

    private rejectTrade(reason: string): void {
      this.log(`Trade Rejected! ${reason}`);
      this.socket.emit(emitEvents.REJECT_TRADE, reason);
      this.close();
    }

    private async initNewTrade(trade: any) {
      this.log(`Init New Trade`);
      const { address, pubkey } = trade;
      if (!address || !pubkey) return this.terminateTrade('Address or Pubkey not provided');
      this.receiverAddress = address;
      this.receiverPubKey = pubkey;
      const pubKeys = [this.listenerPubKey, this.receiverPubKey];
      const amaRes: ApiRes = await this.client("addmultisigaddress", 2, pubKeys);
      if (amaRes.error || !amaRes.data) return this.terminateTrade(amaRes.error);
      this.multySigChannelData = amaRes.data;
      this.log(`Created MultySig Address:`, this.multySigChannelData);
      const validateMS = await this.client("validateaddress", amaRes.data.address);
      if (validateMS.error || !validateMS.data?.scriptPubKey) return this.terminateTrade(amaRes.error);
      this.multySigChannelData.scriptPubKey = validateMS.data.scriptPubKey;
      this.log(`MultySig ScriptPubKey:`, validateMS.data.scriptPubKey);
      const msData = { msData: amaRes.data, listenerPubkey: this.listenerPubKey, listenerAddress: this.listenerAddress };
      this.socket.emit(emitEvents.MULTYSIG_DATA, msData);
    }
  
    private async onCommitToChannel(): Promise<any> {
      this.log(`Commiting Tokens to Channel`);
      const { type } = this.trade;
      switch (type) {
        case TradeTypes.TOKEN_TOKEN_TRADE:
          const tttrade = this.trade as TTTOptions;
          this.comId = tttrade['propIdDesired'];
          this.comAmount = tttrade['amountDeisred'];
        break;
      
        case TradeTypes.LTC_INSTANT_TRADE:
          const ltciTrade = this.trade as LITOptions;
          this.comId = ltciTrade.propertyid;
          this.comAmount = ltciTrade.amount;
        break;

        default:
          break;
      }

      if (!this.comId || !this.comAmount) return this.terminateTrade('Error with Commiting the Tokens');

      const commitData = [        
        this.listenerAddress,
        this.multySigChannelData.address,
        this.comId,
        this.comAmount.toString(),
      ];
      const ctcRes = await this.client("tl_commit_tochannel", ...commitData);
      if (ctcRes.error || !ctcRes.data) return this.terminateTrade(ctcRes.error);
      this.listenerCommitTx = ctcRes.data;

      const gtRes = await this.client("gettransaction", ctcRes.data);
      if (gtRes.error || !gtRes.data?.hex) return this.terminateTrade(gtRes.error || 'Undifined Error 1!');
      const drtRes = await this.client("decoderawtransaction", gtRes.data.hex);
      if (drtRes.error || !drtRes.data) return this.terminateTrade(drtRes.error || 'Undifined Error 2!');
      const vout = drtRes.data.vout.find(o => o.scriptPubKey?.addresses?.[0] === this.multySigChannelData.address);
      if (!vout) return this.terminateTrade(drtRes.error || 'Undifined Error 3!');
      const utxoData = {
        amount: vout.value,
        vout: vout.n,
        txid: ctcRes.data
      };
      this.utxoData = utxoData;
      this.socket.emit(emitEvents.COMMIT_TX, {
        txid: ctcRes.data,
        utxoData: utxoData,
      });
      this.log(`Commit Channel Tx: ${ctcRes.data}. ID: ${this.comId}, amount: ${this.comAmount}`);
    }

    private async onRawTxForSigning(rawTx: string): Promise<any> {
      if (!rawTx) return this.terminateTrade('No RawTx for Signing Provided!');
      this.log(`Signing Raw TX: ${rawTx}`);

      const prevTxsData = {
        txid: this.utxoData.txid,
        vout: this.utxoData.vout,
        scriptPubKey: this.multySigChannelData.scriptPubKey,
        redeemScript: this.multySigChannelData.redeemScript,
        amount: this.utxoData.amount,
      };

      const ssrtxRes: ApiRes = await this.client("signrawtransaction", rawTx, [prevTxsData]);
      if (ssrtxRes.error || !ssrtxRes.data) return this.terminateTrade(ssrtxRes.error);
      if (!ssrtxRes.data.hex) return this.terminateTrade(`Error with Signing Raw TX`);
      this.socket.emit(emitEvents.SIGNED_RAWTX, {hex: ssrtxRes.data.hex, prevTxsData});
      this.log(`Signed Raw TX: ${ ssrtxRes.data.hex}`);
    }
}
