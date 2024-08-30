import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { ApiService } from "./api.service";
import { AuthService } from "./auth.service";
import { BalanceService } from "./balance.service";
import { LoadingService } from "./loading.service";
import { RpcService, TNETWORK } from "./rpc.service";

export interface IUTXO {
    amount: number;
    confirmations: number;
    scriptPubKey: string;
    redeemScript?: string;
    txid: string;
    vout: number;
};

export interface ISignTxConfig {
    rawtx: string;
    wif: string;
    inputs: IUTXO[];
}

export interface ISignPsbtConfig {
    wif: string;
    psbtHex: string;
}

export interface IBuildTxConfig {
    fromKeyPair: {
        address: string;
        pubkey?: string;
    },
    toKeyPair: {
        address: string;
        pubkey?: string;
    },
    inputs?: IUTXO[];
    amount?: number;
    payload?: string;
    addPsbt?: boolean;
    network?: TNETWORK;
}

export interface IBuildLTCITTxConfig {
    buyerKeyPair: {
        address: string;
        pubkey?: string;
    };
    sellerKeyPair: {
        address: string;
        pubkey?: string;
    };
    amount: number;
    payload: string;
    commitUTXOs: IUTXO[],
    network?: TNETWORK;
}

@Injectable({
    providedIn: 'root',
})

export class TxsService {
    constructor(
        private rpcService: RpcService,
        private apiService: ApiService,
        private authService: AuthService,
        private loadingService: LoadingService,
        private toastrService: ToastrService,
        private balanceService: BalanceService,
    ) { }

    get rpc() {
        return this.rpcService.rpc.bind(this);
    }

    get mainApi() {
        return this.apiService.mainApi;
    }

    get tlApi() {
        return this.apiService.tlApi;
    }

    async getWifByAddress(address: string) {
        return this.rpcService.rpc('dumpprivkey', [address]);
    }

    async buildLTCITTx(
        buildTxConfig: IBuildLTCITTxConfig,
    ): Promise<{ data?: { rawtx: string; inputs: IUTXO[], psbtHex?: string }, error?: string }> {
        try {
            const network = this.rpcService.NETWORK;
            buildTxConfig.network = network;
            const isApiMode = this.rpcService.isApiMode;
            let result = await this.mainApi.buildLTCITTx(buildTxConfig, isApiMode).toPromise();
            return result;
        } catch (error: any) {
            return { error: error.message }
        }
    }

   async buildTx(
        buildTxConfig: IBuildTxConfig
    ): Promise<{ data?: { rawtx: string; inputs: IUTXO[], psbtHex?: string }, error?: string }> {
        try {
            console.log('Inputs in build:', JSON.stringify(buildTxConfig));
            if (!buildTxConfig.inputs || buildTxConfig.inputs.length === 0) {
                console.log('error: No inputs available for building the transaction. Please ensure your address has UTXOs.');
            }

            const network = this.rpcService.NETWORK;
            buildTxConfig.network = network;
            const isApiMode = this.rpcService.isApiMode;
            let result = await this.mainApi.buildTx(buildTxConfig, isApiMode).toPromise();
            return result;
        } catch (error: any) {
            return { error: error.message || 'An unexpected error occurred while building the transaction.' }
        }
    }

   async buildSingSendTx(
            buildTxConfig: IBuildTxConfig,
        ): Promise<{ data?: string, error?: string }> {
            try {
                this.loadingService.isLoading = true;
                const buildRes = await this.buildTx(buildTxConfig);
                if (buildRes.error || !buildRes.data) {
                    return { error: buildRes.error || 'Failed to build the transaction.' };
                }

                const { inputs, rawtx } = buildRes.data;

                // if (!inputs || !rawtx) return { error: 'No inputs or raw transaction data available.' };
                // const keyPair = this.authService.listOfallAddresses.find(e => e.address === buildTxConfig.fromKeyPair.address);
                // if (!keyPair) return { error: `Could not find the keys for address: ${buildTxConfig.fromKeyPair.address}.` };
                // const wifRes = await this.rpcService.rpc('dumpprivkey', [buildTxConfig.fromKeyPair.address]);
                // if (!wifRes || wifRes.error) return { error: `Error with finding keys for address: ${buildTxConfig.fromKeyPair.address}.` };
                // const wif = wifRes.data;
                // const signRes = await this.signTx({ inputs, rawtx, wif });

                const signRes = await this.signRawTxWithWallet(rawtx);
                if (signRes.error || !signRes.data) {
                    return { error: signRes.error || 'Failed to sign the transaction.' };
                }

                const { isValid, signedHex } = signRes.data;
                if (!isValid || !signedHex) {
                    return { error: 'The transaction is not valid or could not be signed.' };
                }

                const sendRes = await this.sendTx(signedHex);
                if (sendRes.error || !sendRes.data) {
                    return { error: sendRes.error || 'Failed to broadcast the transaction.' };
                }

                return { data: sendRes.data };
            } catch (error: any) {
                this.toastrService.error(error.message);
                return { error: error.message };
            } finally {
                this.loadingService.isLoading = false;
                this.balanceService.updateBalances();
            }
        }


    async signTx(signTxConfig: ISignTxConfig): Promise<{
        data?: {
            isValid: boolean,
            signedHex?: string,
            psbtHex?: string,
        },
        error?: string,
    }> {
        try {
            const network = this.rpcService.NETWORK;
            const result = await this.mainApi.signTx(signTxConfig, network).toPromise();
            return result;
        } catch (error: any) {
            return { error: error.message }
        }
    }

    async signRawTxWithWallet(txHex: string): Promise<{
        data: { isValid: boolean, signedHex?: string },
        error?: string
    }> {
        const result = await this.rpcService.rpc('signrawtransactionwithwallet', [txHex]);
        const data = { isValid: result.data.complete, signedHex: result.data.hex }
        return { data };
    }

    async signPsbt(signPsbtConfig: ISignPsbtConfig): Promise<{
        data?: {
            psbtHex: string;
            isValid: boolean;
            isFinished: boolean;
            finalHex?: string;
        },
        error?: string,
    }> {
        try {
            const network = this.rpcService.NETWORK;
            const result = await this.mainApi.signPsbt(signPsbtConfig, network).toPromise();
            return result
        } catch (error: any) {
            return { error: error.message }
        }
    }

    async sendTx(rawTx: string) {
        const result = await this.rpcService.rpc('sendrawtransaction', [rawTx]);
        this.balanceService.updateBalances();
        return result;
    }

    async getChannel(address: string){
        const channelRes = await this.tlAPI.rpc('tl_getChannel', [address]).toPromise();
        console.log('channel fetch in tx service '+JSON.stringify(channelRes))
         if (!channelRes.data || channelRes.error) return { data: [] };
        
        return channelRes.data
    }

    async checkMempool(txid: string) {
        try {
            const mempool = await this.rpcService.rpc('getrawmempool', []).toPromise();;
            
            // Check if the txid is in the mempool
            const isInMempool = mempool.includes(txid);

            return isInMempool;
        } catch (error) {
            console.error('Error checking mempool:', error);
            return false;
        }
    }

    async predictColumn (channel:string, cpAddress:string){
        try {
            const column = await this.tlAPI.rpc('tl_getChannelColumn', [channel,cpAddress]).toPromise();;
            console.log('column prediction fetch in tx service '+JSON.stringify(column))

            return column.data;
        } catch (error) {
            console.error('Error checking column:', error);
            return false;
        }
    }

    async sendTxWithSpecRetry(rawTx: string) {
        const _sendTxWithRetry = async (rawTx: string, retriesLeft: number, ms: number): Promise<{
            data?: string,
            error?: string,
        }> => {
            const result = await this.rpcService.rpc('sendrawtransaction', [rawTx]);
            if (result.error && result.error.includes('bad-txns-inputs-missingorspent') && retriesLeft > 0) {
                await new Promise(resolve => setTimeout(resolve, ms));
                return _sendTxWithRetry(rawTx, retriesLeft - 1, ms);
            }
            return result;
        }
        return _sendTxWithRetry(rawTx, 15, 800);
    }
}

  