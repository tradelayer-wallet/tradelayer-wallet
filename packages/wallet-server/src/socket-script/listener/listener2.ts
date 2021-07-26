// import { createServer } from "http";
// import { Server, Socket } from "socket.io";
// import { Events2 as emmitEvents, Events1 as onEvents } from '../common/enums/events';
// import { TradeTypes } from "../common/enums/tradeTypes";
// import { api } from '../common/tl-api';
// import { ApiRes, LITOptions, Trade, TTTOptions } from "../common/types/types";

// import { io } from "socket.io-client";
// import * as fs from 'fs';

// export class ListenerServer {
//   private io: Server;
//   private serverOptions: any;
//   private port: number;

//   constructor(address: string, port: number) {
//     this.port = port
//     this.init(port);
//     this.serverOptions = { address };
//   }

//   close(): void {
//     this.io.close();
//   }

//   joinPool(pool: string) {
//     const poolClient = io(pool, { reconnection: false });
//     poolClient.on('connect', () => {
//       console.log(`Connected to pool: ${pool}`)
//       poolClient.on('settingsRequest', async () => {
//         const port = this.port;
//         const address = this.serverOptions.address;
//         const vaRes: ApiRes = await api.validateAddress(address);
//         if (vaRes.error || !vaRes.data) return;
//         const publicKey = vaRes.data.pubkey;

//         const settings = { port, addressObj: { address, publicKey }};
//         poolClient.emit('settingsAnswer', settings);
//       })
//     });
//   }

//   private init(port: number): void {
//     console.log(`Start Listener Server on port ${port}`);
//     const httpServer = createServer();
//     const socketOptions = { cors: { origin: "*", methods: ["GET", "POST"] } };
//     httpServer.listen(port);
//     this.io = new Server(httpServer, socketOptions);
//     this.io.on("connection", this.onConnection.bind(this));
//   }

//   private onConnection(socket: Socket): void {
//     new Listener(socket, this.serverOptions)
//   }
// }

// class Listener {
//     private socket: Socket;
//     private logs: boolean = false;
//     private trade: Trade;

//     private listenerAddress: string;
//     private receiverAddress: string;

//     private listenerChannelPubKey: string;
//     private receiverChannelPubKey: string;
//     private multySigChannelData: any;

//     private comId: number;
//     private comAmount: string;

//     private listenerCommitTx: string;
  
//     private utxoData: any;
//     constructor(socket: Socket, server: any) {
//       this.socket = socket,
//       this.logs = server.options.logs;
//       this.listenerAddress = server.address;
//       this.init()
//     }

//     close(): void {
//       this.socket.disconnect();
//     }

//     private log(message: string, data?: any): void {
//       if (this.logs) console.log(`${message} ${JSON.stringify(data, null, "\t") || ''}`);
//     }

//     private saveToLog(data: any) {
//       const time = new Date();
//       const message = JSON.stringify({ message: data, time }, null, "\t");
//       fs.appendFile(`listener.log`, message + '\n', (err) => {
//         if (err) throw err;
//       });
//     }
  
//     private init(): void {
//       this.log(`New Connection: ID ${this.socket.id}`);
//       this.handleListeners();
//     }

//     private handleListeners(): void {
//       this.socket.on(onEvents.TRADE_REQUEST, this.onTradeRequest.bind(this));
//       // this.socket.on(onEvents.CHANNEL_PUB_KEY, this.onChannelPubKey.bind(this));
//       this.socket.on(onEvents.COMMIT_TO_CHANNEL, this.onCommitToChannel.bind(this));
//       this.socket.on(onEvents.RAWTX_FOR_SIGNING, this.onRawTxForSigning.bind(this));

//       this.socket.on('commit', async (commitOpt) => {
//         const { channel, token, amount } = commitOpt;
//         const commitData = [ this.listenerAddress, channel, parseInt(token), amount ];
//         const ctcRes: ApiRes = await api.commitToChannel(...commitData);
//         this.socket.emit('commitRes', ctcRes);
//       })
//     }

//     private rejectTrade(reason: string): void {
//       this.log(`Trade Rejected! ${reason}`);
//       this.socket.emit(emmitEvents.REJECT_TRADE, reason);
//       this.saveToLog({title: `Trade Rejected`, reason});
//       this.close();
    
//     }

//     private terminateTrade(reason: string = 'No info'): void {
//       this.log(`Trade Terminated! ${reason}`);
//       this.socket.emit(emmitEvents.TERMINATE_TRADE, reason);
//       this.close();
//     }
  
//     private async initNewTrade(trade: any): Promise<any> {
//       this.log(`Init New Trade!`);

//       this.log(`Creating New Address`);
//       const gnaRes: ApiRes = await api.getNewAddress();
//       if (gnaRes.error || !gnaRes.data) return this.terminateTrade(gnaRes.error);
//       const gnaData = gnaRes.data;
//       this.log(`Created New Address ${gnaData}`);

//       this.log(`Validating Address`);
//       const vaRes: ApiRes = await api.validateAddress(gnaRes.data);
//       if (vaRes.error || !vaRes.data) return this.terminateTrade(vaRes.error);
//       const vaData = vaRes.data;
//       this.listenerChannelPubKey = vaData.pubkey;
//       this.socket.emit(emmitEvents.CHANNEL_PUB_KEY, vaData);
//       this.log(`Valid Address. Pubkey: ${vaData.pubkey}`);
//     }

//     private async initNewTrade_2(trade: any) {
//       this.log(`Init New Trade`);
//       const { address, pubkey } = trade;

//       this.receiverAddress = address;
//       this.receiverChannelPubKey = pubkey;

//       const address2 = this.listenerAddress;
//       const vaRes: ApiRes = await api.validateAddress(address2);
//       if (vaRes.error || !vaRes.data) return;
//       const cpPubkey = vaRes.data.pubkey;

//       this.listenerChannelPubKey = cpPubkey;

//       if (!this.listenerChannelPubKey || !this.receiverChannelPubKey) return this.terminateTrade('Fail building Trade');
//       this.log(`Creating MultySig Address`);
//       const pubKeys = [ this.listenerChannelPubKey, this.receiverChannelPubKey ];
//       const amaRes: ApiRes = await api.addMultisigAddress(2, pubKeys);
//       if (amaRes.error || !amaRes.data) return this.terminateTrade(amaRes.error);
//       this.multySigChannelData = amaRes.data;
//       this.log(`Created MultySig Address:`, amaRes.data);
//       this.saveToLog(amaRes.data);
//       const validateMS = await api.validateAddress(amaRes.data.address);
//       if (validateMS.error || !validateMS.data?.scriptPubKey) return this.terminateTrade(amaRes.error);
//       this.multySigChannelData.scriptPubKey = validateMS.data.scriptPubKey;
//       this.log(`MultySig ScriptPubKey:`, validateMS.data.scriptPubKey);
//       this.socket.emit(emmitEvents.MULTYSIG_DATA, amaRes.data);
//     }
//     // onMethods
//     private onTradeRequest(trade: any): void {
//       this.log(`Trade Request:`, trade);
//       this.trade = trade;
//       const isValid = true;
//       isValid ? this.initNewTrade_2(trade) : this.rejectTrade('Bad Trade');
//       this.saveToLog({title: `New trade request`, data: trade});
//     }

//     private async onChannelPubKey(pubkey: string): Promise<any> {
//       if (!pubkey) this.terminateTrade(`No pubKey Received`)
//       this.log(`Received PubKey: ${pubkey}`);
//       this.receiverChannelPubKey = pubkey;
      
//       this.log(`Creating MultySig Address`);
//       const pubKeys = [ this.listenerChannelPubKey, this.receiverChannelPubKey ];
//       const amaRes: ApiRes = await api.addMultisigAddress(2, pubKeys);
//       if (amaRes.error || !amaRes.data) return this.terminateTrade(amaRes.error);
//       this.multySigChannelData = amaRes.data;
//       this.socket.emit(emmitEvents.MULTYSIG_DATA, amaRes.data)
//       this.log(`Created MultySig Address:`, amaRes.data);
//     }
//     private async onCommitToChannel(): Promise<any> {
//       this.log(`Commiting Tokens to Channel`);
//       const { type } = this.trade;
//       switch (type) {
//         case TradeTypes.TOKEN_TOKEN_TRADE:
//           const tttrade = this.trade as TTTOptions;
//           this.comId = tttrade['propIdDesired'];
//           this.comAmount = tttrade['amountDeisred'];
//         break;
      
//         case TradeTypes.LTC_INSTANT_TRADE:
//           const ltciTrade = this.trade as LITOptions;
//           this.comId = ltciTrade.propertyid;
//           this.comAmount = ltciTrade.amount;
//         break;

//         default:
//           break;
//       }

//       if (!this.comId || !this.comAmount) return this.terminateTrade('Error with Commiting the Tokens');

//       const commitData = [        
//         this.listenerAddress,
//         this.multySigChannelData.address,
//         this.comId,
//         this.comAmount.toString(),
//       ];
//       const ctcRes: ApiRes = await api.commitToChannel(...commitData);
//       if (ctcRes.error || !ctcRes.data) return this.terminateTrade(ctcRes.error);
//       this.listenerCommitTx = ctcRes.data;

//       // const lusRes: ApiRes = await api.listunspent(0, 9999999, [this.multySigChannelData.address]);
//       // if (lusRes.error || !lusRes.data?.length) return this.terminateTrade(ctcRes.error);
//       // const voutnAmount = lusRes.data.find((us: any) => us.txid === this.listenerCommitTx)
//       // if (!voutnAmount) return this.terminateTrade('Error');

//       const gtRes = await api.gettransaction(ctcRes.data);
//       if (gtRes.error || !gtRes.data?.hex) return this.terminateTrade(gtRes.error || 'Undifined Error 1!');
//       const drtRes = await api.decoderawtransaction(gtRes.data.hex);
//       if (drtRes.error || !drtRes.data) return this.terminateTrade(drtRes.error || 'Undifined Error 2!');
//       const vout = drtRes.data.vout.find(o => o.scriptPubKey?.addresses?.[0] === this.multySigChannelData.address);
//       if (!vout) return this.terminateTrade(drtRes.error || 'Undifined Error 3!');
//       const utxoData = {
//         amount: vout.value,
//         vout: vout.n,
//         txid: ctcRes.data
//       };
//       this.utxoData = utxoData;
//       this.socket.emit(emmitEvents.COMMIT_TX, {
//         txid: ctcRes.data,
//         utxoData: utxoData,
//         channelAddress: this.multySigChannelData,
//       });
//       this.log(`Commit Channel Tx: ${ctcRes.data}. ID: ${this.comId}, amount: ${this.comAmount}`);
//       this.saveToLog(`Commit Channel Tx: ${ctcRes.data}. ID: ${this.comId}, amount: ${this.comAmount}`);
//     }

//     private async onRawTxForSigning(rawTx: string): Promise<any> {
//       if (!rawTx) return this.terminateTrade('No RawTx for Signing Provided!');
//       this.log(`Signing Raw TX: ${rawTx}`);


//       const prevTxsData = {
//         txid: this.utxoData.txid,
//         vout: this.utxoData.vout,
//         scriptPubKey: this.multySigChannelData.scriptPubKey,
//         redeemScript: this.multySigChannelData.redeemScript,
//         amount: this.utxoData.amount,
//       };
//       const ssrtxRes: ApiRes = await api.signWithPrevTxs(rawTx, [prevTxsData]);
//       // const ssrtxRes: ApiRes = await api.simpleSignRawTx(rawTx);
//       if (ssrtxRes.error || !ssrtxRes.data) return this.terminateTrade(ssrtxRes.error);
//       if (!ssrtxRes.data.hex) return this.terminateTrade(`Error with Signing Raw TX`);
//       this.socket.emit(emmitEvents.SIGNED_RAWTX, {hex: ssrtxRes.data.hex, prevTxsData});
//       this.log(`Signed Raw TX: ${ ssrtxRes.data.hex}`);
//       this.saveToLog({title: `Signed Raw TX`, data: ssrtxRes.data.hex })
//     }
// }
