import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { AddressService } from "./address.service";
import { BalanceService } from "./balance.service";
import { RpcService } from "./rpc.service";
import { SocketEmits, SocketService } from "./socket.service";
import { TxsService } from "./txs.service";

export interface ITradeConf {
    propIdForSale: number;
    propIdDesired: number;
    amountForSale: number;
    amountDeisred: number;
    clientPubKey?: string;
    clientAddress?: string;
}

@Injectable({
    providedIn: 'root',
})

export class TradeService {
    constructor(
        private socketService: SocketService,
        private toasterService: ToastrService,
        private addressService: AddressService,
        private rpcService: RpcService,
        private balanceService: BalanceService,
        private txsService: TxsService,
    ) {
        this.handleSocketEvents()
    }

    get keyPair() {
        return this.addressService.activeKeyPair;
    }

    get socket() {
        return this.socketService.socket;
    }

    initTrade(tradeConf: ITradeConf) {
        if (tradeConf.amountDeisred > 5) {
            this.toasterService.warning('For this test Version You cant buy more than 5 Tokens in Single trade!', 'Too big amount!');
            return;
        }
        if (tradeConf.propIdForSale === 999 ) {
            this.handleLTCInstantTrade(tradeConf);
        } else {
        }
    }

    private handleLTCInstantTrade(tradeConf: ITradeConf) {
        const _tradeConf: ITradeConf = {
            ...tradeConf,
            clientPubKey: this.keyPair?.pubKey,
            clientAddress: this.keyPair?.address,
        };
        this.socket.emit(SocketEmits.LTC_INSTANT_TRADE, _tradeConf);
    }

    private handleSocketEvents() {
        let multySigAddress: any;
        this.socket.on('TRADE_REJECTION', (reason) => {
            this.toasterService.error('Trade Rejected', `Reason: ${reason || 'Reason Not Found'}`);
        });

        this.socket.on('CHANNEL_PUB_KEY', async (cpPubKey: string) => {
            if (!cpPubKey) {
                this.toasterService.error('Trade Building Faild', `Trade Building Faild`);
                return;
            }
            const pubKeysArray = [cpPubKey, this.keyPair?.pubKey];
            const amaRes = await this.rpcService.rpc('addmultisigaddress', [2, pubKeysArray]);
            if (amaRes.error || !amaRes.data) {
                this.toasterService.error('Trade Building Faild', `Trade Building Faild`);
            } else {
                multySigAddress = amaRes.data.address;
                this.socket.emit('MULTYSIG_DATA', amaRes.data);
            }
        });

        this.socket.on('COMMIT_TX', async (data: any) => {
            if (data?.cpCommitTx?.txid && data?.tradeConf) {
                const rawHex = await this.buildLTCInstantTrade(data);
                if (!rawHex) return;
                this.socket.emit('RAW_HEX', rawHex)
            } else {
                this.toasterService.error('Building Raw Tx fail', `Trade Building Faild`);
            }
        });

        this.socket.on('SIGNED_RAWTX', async (rawTxForSigning) => {
            const signRes = await this.rpcService.rpc('signrawtransaction', [rawTxForSigning]);
            if (signRes.error || !signRes.data || !signRes.data.complete || !signRes.data.hex) {
                this.toasterService.error('Singing fail', `Trade Building Faild`);
            } else {
                const srawtxRes = await this.rpcService.rpc('sendrawtransaction', [signRes.data.hex]);
                if (srawtxRes.error || !srawtxRes.data ) {
                    this.toasterService.error(srawtxRes.error || 'sending fail',`Trade Building Faild`);
                } else {
                    this.toasterService.success('TRANSACTION SENDED!', `${srawtxRes.data}`);
                    this.txsService.addTxToPending(srawtxRes.data);
                    setTimeout(() => {
                        if (this.keyPair?.address) {
                            this.balanceService.updateLtcBalanceForAddress(this.keyPair?.address);
                            this.balanceService.updateTokensBalanceForAddress(this.keyPair?.address);
                        }
                    }, 2000);

                }
            }

        })
    }
    
    private async buildLTCInstantTrade(data: any){
        const { tradeConf, cpCommitTx } = data;
        const _cpCommitTx = {
            txid: cpCommitTx.txid,
            vout: 2,
            amount: 0.00036,
        };
        const bbData: number = await this.getBestBlock(10);
        const { propIdDesired, amountDeisred, amountForSale, clientAddress, cpAddress } = tradeConf;
        const cpitLTCOptions = [ propIdDesired, amountDeisred.toString(), amountForSale.toString(), bbData ];
        const cpitRes = await this.rpcService.rpc('tl_createpayload_instant_ltc_trade', cpitLTCOptions)
        if (cpitRes.error || !cpitRes.data) {
            this.toasterService.error('Creating payload Failed', `Trade Building Faild`);
        }

        const clientVins = await this.rpcService.getUnspentsForFunding(clientAddress, amountForSale);
        if (clientVins.error || !clientVins.data?.length) {
            this.toasterService.error(clientVins.error || 'Trade Building Faild', `Trade Building Faild`);
        }
        const vins = [_cpCommitTx, ...clientVins.data];
        const bLTCit = await this.rpcService.buildLTCInstantTrade(vins, cpitRes.data, clientAddress, amountForSale.toString(), cpAddress);
        if (bLTCit.error || !bLTCit.data) {
            this.toasterService.error(bLTCit.error || 'Trade Building Faild', `Trade Building Faild`);
        }
        return bLTCit.data;
    }

    protected async getBestBlock(n: number) {
        const bbRes = await this.rpcService.getBestBlock();
        if (bbRes.error || !bbRes.data || !bbRes.data.height) {
            this.toasterService.error('Get best block hash failed', `Trade Building Faild`);
        }

        const height = bbRes.data.height + n;
        return height;
    }
}
