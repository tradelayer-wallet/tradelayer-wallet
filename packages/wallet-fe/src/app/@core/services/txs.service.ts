import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { ApiService } from "./api.service";
import { AuthService } from "./auth.service";
import { LoadingService } from "./loading.service";
import { RpcService } from "./rpc.service";

export interface IUTXO {
    amount: number;
    confirmations: number;
    scriptPubKey: string;
    txid: string;
    vout: number;
};

export interface ISignTxConfig {
    rawtx: string;
    wif: string;
    inputs: IUTXO[];
}

export interface IBuildTxConfig {
    fromAddress: string;
    toAddress: string;
    amount?: number;
    payload?: string;
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
    ) {}

    get rpc() {
        return this.rpcService.rpc.bind(this);
    }

    get mainApi() {
        return this.apiService.mainApi;
    }

    async buildTx(
            buildTxConfig: IBuildTxConfig, 
        ): Promise<{ data?: { rawtx: string; inputs: any[] }, error?: string }> {
        try {
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
            signedHex: string,
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

    async sendTx(rawTx: string) {
        const result = await this.rpcService.rpc('sendrawtransaction', [rawTx]);
        return result;
    }

    async buildSingSendTx(
        buildTxConfig: IBuildTxConfig, 
    ): Promise<{ data?: string, error?: string }> {
        try {
            this.loadingService.isLoading = true;
            const buildRes = await this.buildTx(buildTxConfig);
            if (buildRes.error || !buildRes.data) throw new Error(buildRes.error);
            const { inputs, rawtx } = buildRes.data;
            if (!inputs || !rawtx) throw new Error('buildSingSendTx: Undefined Error with building Transaction');
            const keyPair = this.authService.listOfallAddresses.find(e => e.address === buildTxConfig.fromAddress);
            if (!keyPair) throw new Error(`Error with finding Keys of address: ${buildTxConfig.fromAddress}`);
            const wif = keyPair.wif;
            const signRes = await this.signTx({ inputs, rawtx, wif });
            if (signRes.error || !signRes.data) throw new Error(signRes.error);
            const { isValid, signedHex } = signRes.data;
            if (!isValid || !signedHex) throw new Error("buildSingSendTx: Undefined Error with signing Transaction");
            const sendRes = await this.sendTx(signedHex);
            if (sendRes.error || !sendRes.data) throw new Error(sendRes.error);
            this.toastrService.success(sendRes.data, 'Successful Send');
            return { data: sendRes.data};
        } catch(error: any) {
            this.toastrService.error(error.message);
            return { error: error.message };
        } finally {
            this.loadingService.isLoading = false;
        }
    }
}