// import { Receiver } from './receiver';
// import { Events1 as emmitEvents, Events2 as onEvents } from '../common/enums/events';
// import { ApiRes, ROptions, TTTOptions } from '../common/types/types';
// import { api } from '../common/tl-api';

// export class TokenTokenTrade extends Receiver {

//     constructor(host: string, trade: TTTOptions, options: ROptions, send: boolean) {
//         super(host, trade, options, send);
//     }

//     protected initTrade() {
//         this.log(`Init Token/Token Trade !`);
//         this.handleSubListeners();
//         this.socket.emit(emmitEvents.COMMIT_TO_CHANNEL);
//     }

//     private handleSubListeners(): void {
//         this.socket.on(onEvents.COMMIT_TX, this.onCommitTx.bind(this));
//     }

//     private async onCommitTx(commitTx: string) {
//         this.log(`Received Listener Commit TX: ${commitTx}`);
//         const { address, propertyid, amount } = this.trade;
//         const msAddress = this.multySigChannelData.address;

//         if (!address || !propertyid || !amount) return this.terminateTrade('Error with Provided Trade Information');
//         if (!this.multySigChannelData?.address) return this.terminateTrade(`Can't Find multisig Channel Address`);

//         const commitData = [ address, msAddress, propertyid, amount ];
//         const ctcData: string = await this.commitToChannel(commitData);
//         if (!ctcData) return this.terminateTrade('Error with Commiting Tokens to Multsig Channel!');

//         this.commitsTx = [ commitTx, ctcData ];

//         const msus: any[] = await this.listUnspent(this.multySigChannelData.address);
//         if (!msus || msus.length < 2) return this.terminateTrade('Error with Founding 2 Unspents!');

//         // console.log(msus);

//         const btttData: string = await this._bildTokenTokenTrade(msus);
//         this.socket.emit(emmitEvents.RAWTX_FOR_SIGNING, btttData);
//     }

//     private async _bildTokenTokenTrade(msus: any[]) {
//         this.log(`Building Token/Token Trade`);
//         const bbData: number = await this.getBestBlock(10);

//         this.log(`Creating Instat Trade payload`);
//         const trade = this.trade as TTTOptions;
//         const { propertyid, amount, propertydesired, amountdesired, address } = trade;
        
//         const gci: ApiRes = await api.getchannel_info(address);
//         if (gci.error || !gci.data) return this.terminateTrade(gci.error || 'Error with Getting Multisig Channel info');
//         // const reversed = !(gci.data['first address'] === address);

//         const cpitOptions = [propertyid, amount, propertydesired, amountdesired, bbData ];

//         const cpitRes: ApiRes = await api.createPayload_instantTrade(...cpitOptions);
//         if (cpitRes.error || !cpitRes.data) return this.terminateTrade(cpitRes.error || 'Error with Creating the Payload');
//         this.log(`Created Instat Trade payload: ${cpitRes.data}`);

//         const vins = msus.map(us => ({txid: us.txid, vout: us.vout}));
//         // const refAddress = this.multySigChannelData.address;

//         const gtRes: ApiRes = await api.tl_gettransaction(msus[0].txid);
//         if (gtRes.error || !gtRes.data?.sendingaddress) return this.terminateTrade(cpitRes.error);

//         const firstAddress = address;
//         const secondAddress = gtRes.data.sendingaddress;
//         const bttt: ApiRes = await api.buildTokenTokenTrade(vins, cpitRes.data, firstAddress, secondAddress);
//         if (bttt.error || !bttt.data.hex) return this.terminateTrade(cpitRes.error || 'Error with Creating the Payload');
//         this.log(`Created RawTx: ${bttt.data.hex}`);
//         return bttt.data.hex
//     }

// }