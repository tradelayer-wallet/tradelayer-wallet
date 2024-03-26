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
    ) {}

    get rpc() {
        return this.rpcService.rpc.bind(this);
    }

    get mainApi() {
        return this.apiService.mainApi;
    }

    getWifByAddress(address: string) {
        return '';
    }

    async buildLTCITTx(
        buildTxConfig: IBuildLTCITTxConfig,
    ): Promise<{ data?: { rawtx: string; inputs: IUTXO[], psbtHex?: string }, error?: string }>
    {
        try {
            const network = this.rpcService.NETWORK;
            buildTxConfig.network = network;
            const isApiMode = this.rpcService.isApiMode;
            let result = await this.mainApi.buildLTCITTx(buildTxConfig, isApiMode).toPromise();
            return result;
        } catch(error: any) {
            return { error: error.message }
        }
    }

    async buildTx(
            buildTxConfig: IBuildTxConfig, 
        ): Promise<{ data?: { rawtx: string; inputs: IUTXO[], psbtHex?: string }, error?: string }> {
        try {
            const network = this.rpcService.NETWORK;
            buildTxConfig.network = network;
            const isApiMode = this.rpcService.isApiMode;
            let result = await this.mainApi.buildTx(buildTxConfig, isApiMode).toPromise();
            return result;
        } catch(error: any) {
            return { error: error.message }
        }
    }

    async signTx(signTxConfig: ISignTxConfig): Promise<{
        data?: {
            isValid: boolean,
            signedHex?: string,
            psbtHex?: string,
        },
        error?: string,
    }>  {
        try {
            const network = this.rpcService.NETWORK;
            const result = await this.mainApi.signTx(signTxConfig, network).toPromise();
            return result;
        } catch(error: any) {
            return { error: error.message }
        }
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
        } catch(error: any) {
            return { error: error.message }
        }
    }

    async sendTx(rawTx: string) {
        const result = await this.rpcService.rpc('sendrawtransaction', [rawTx]);
        this.balanceService.updateBalances();
        return result;
    }

    async buildSingSendTx(
        buildTxConfig: IBuildTxConfig, 
    ): Promise<{ data?: string, error?: string }> {
        try {
            this.loadingService.isLoading = true;
            const buildRes = await this.buildTx(buildTxConfig);
            console.log({buildRes})
            if (buildRes.error || !buildRes.data) throw new Error(buildRes.error);
            const { inputs, rawtx } = buildRes.data;
            if (!inputs || !rawtx) throw new Error('buildSingSendTx: Undefined Error with building Transaction');
            // const keyPair = this.authService.listOfallAddresses.find(e => e.address === buildTxConfig.fromKeyPair.address);
            // if (!keyPair) throw new Error(`Error with finding Keys of address: ${buildTxConfig.fromKeyPair.address}`);
            const wifRes = await this.rpcService.rpc('dumpprivkey', [buildTxConfig.fromKeyPair.address]);
            if (!wifRes) throw new Error(`Error with finding Keys of address: ${buildTxConfig.fromKeyPair.address}`);
            const wif = wifRes.data;
            const signRes = await this.signTx({ inputs, rawtx, wif });
            if (signRes.error || !signRes.data) throw new Error(signRes.error);
            const { isValid, signedHex } = signRes.data;
            if (!isValid || !signedHex) throw new Error("buildSingSendTx: Undefined Error with signing Transaction");
            const sendRes = await this.sendTx(signedHex);
            if (sendRes.error || !sendRes.data) throw new Error(sendRes.error);
            return { data: sendRes.data};
        } catch(error: any) {
            this.toastrService.error(error.message);
            return { error: error.message };
        } finally {
            this.loadingService.isLoading = false;
            this.balanceService.updateBalances();
        }
    }
}