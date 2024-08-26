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
            if (!buildTxConfig.inputs || buildTxConfig.inputs.length === 0) {
                return { error: 'No inputs available for building the transaction. Please ensure your address has UTXOs.' };
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
        buildTxConfig: IBuildTxConfig
    ): Promise<{ data?: string, error?: string }> {
        try {
            this.loadingService.isLoading = true;

            if (!buildTxConfig.inputs || buildTxConfig.inputs.length === 0) {
                return { error: 'No inputs available for the transaction. Please ensure your address has UTXOs.' };
            }

            const buildRes = await this.buildTx(buildTxConfig);
            if (buildRes.error || !buildRes.data) {
                return { error: buildRes.error || 'Failed to build the transaction. Please try again.' };
            }
            
            const { inputs, rawtx } = buildRes.data;
            const keyPair = this.authService.listOfallAddresses.find(e => e.address === buildTxConfig.fromKeyPair.address);
            if (!keyPair) {
                return { error: `Could not find the keys for address: ${buildTxConfig.fromKeyPair.address}.` };
            }

            const wif = keyPair.wif;
            const signRes = await this.signTx({ inputs, rawtx, wif });
            if (signRes.error || !signRes.data) {
                return { error: signRes.error || 'Failed to sign the transaction. Please try again.' };
            }

            const { isValid, signedHex } = signRes.data;
            if (!isValid || !signedHex) {
                return { error: 'The transaction is not valid or could not be signed. Please review the transaction details.' };
            }

            const sendRes = await this.sendTx(signedHex);
            if (sendRes.error || !sendRes.data) {
                return { error: sendRes.error || 'Failed to broadcast the transaction. Please check your network connection and try again.' };
            }

            return { data: sendRes.data };
        } catch (error: any) {
            return { error: error.message || 'An unexpected error occurred while processing the transaction.' };
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

  