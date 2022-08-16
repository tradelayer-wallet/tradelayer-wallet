import { Injectable } from "@angular/core";
import { ApiService } from "./api.service";
import { ENetwork, RpcService, TNETWORK } from "./rpc.service";

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
    ) {}

    get rpc() {
        return this.rpcService.rpc.bind(this);
    }

    get mainApi() {
        return this.apiService.mainApi;
    }

    async buildTx(
            buildTxConfig: IBuildTxConfig, 
            autoSignSend: boolean = false,
        ): Promise<{ data?: { rawtx: string; inputs: any[] }, error?: string }> {
        try {
            const isApiMode = this.rpcService.isApiMode;
            let result = await this.mainApi.buildTx(buildTxConfig, isApiMode).toPromise();
            return result;
        } catch(error: any) {
            return { error: error.message }
        }
    }

    async signTx(signTxConfig: ISignTxConfig): Promise<{ data?: string, error?: string }>  {
        try {
            const network = this.rpcService.NETWORK;
            let result = await this.mainApi.signTx(signTxConfig, network).toPromise();
            return result;
        } catch(error: any) {
            return { error: error.message }
        }
    }

    sendTx(rawTx: string) {

    }
}