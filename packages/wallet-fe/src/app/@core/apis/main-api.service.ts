import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { environment } from "src/environments/environment";
import { ENetwork, TNETWORK } from "../services/rpc.service";
import { IBuildTxConfig, ISignPsbtConfig, ISignTxConfig } from "../services/txs.service";
// import { ENetwork, RPCCredentials } from "../services/rpc.service";

@Injectable({
    providedIn: 'root',
})

export class MainApiService {

    constructor(
        private http: HttpClient,
    ) {}

    private get apiUrl() {
        return environment.homeApiUrl + '/api/'
    }

    setNETWORK(value: TNETWORK) {
        const apiUrl = value === "LTC"
            ? environment.ENDPOINTS.LTC.relayerUrl
            : value === "LTCTEST"
                ? environment.ENDPOINTS.LTCTEST.relayerUrl
                : null;
        return this.http.post(this.apiUrl + 'set-api-url', { apiUrl });
    }
    
    startWalletNode(
            path: string,
            network: ENetwork,
            flags: { reindex: boolean; startclean: boolean },
        ): Observable<any> {
        const { reindex, startclean } = flags;
        const body = {
            network,
            startclean,
            reindex,
            path,
        };
        return this.http.post(this.apiUrl + 'start-wallet-node', body);
    }

    stopWalletNode() {
        const body = {};
        return this.http.post(this.apiUrl + 'stop-wallet-node', body);
    }

    createNewConfFile(
        body: {
            username: string;
            password: string;
            port: number;
            path: string;
        }
    ): Observable<any> {
        return this.http.post(this.apiUrl + 'new-config', body);
    };

    rpcCall(method: string, params?: any[]): Observable<{
        data?: any;
        error?: string;
        statusCode: number;
    }> {
        const body = { method, params };
        return this.http.post<{
            data?: any;
            error?: string;
            statusCode: number;
        }>(this.apiUrl + 'rpc-call', body)
    }

    buildTx(buildTxConfig: IBuildTxConfig, isApiMode: boolean): Observable<{
        data?: { rawtx: string; inputs: any[]};
        error?: string;
    }>{
        return this.http.post<{
            data?: { rawtx: string; inputs: any[]};
            error?: string;  
        }>(this.apiUrl + 'build-tx', { ...buildTxConfig, isApiMode })
    }

    // buildPsbt(buildPSBTConfig: IBuildPSBTConfig, isApiMode: boolean): Observable<{
    //     data?: { rawtx: string; psbtTx: string; inputs: any[] };
    //     error?: string;
    // }>{
    //     return this.http.post<{
    //         data?: { rawtx: string; psbtTx: string; inputs: any[]};
    //         error?: string;  
    //     }>(this.apiUrl + 'build-psbt', { ...buildPSBTConfig, isApiMode })
    // }

    signTx(buildTxConfig: ISignTxConfig, network: TNETWORK): Observable<{
        data?: {
            isValid: boolean;
            signedHex?: string;
            psbtHex?: string,
        };
        error?: string;
    }>{
        return this.http.post<{
            data?: {
                isValid: boolean;
                signedHex?: string;
                psbtHex?: string,
            };
            error?: string;  
        }>(this.apiUrl + 'sign-tx', { ...buildTxConfig, network })
    }

    signPsbt(buildPsbtConfig: ISignPsbtConfig, network: TNETWORK): Observable<{
        data?: {
            psbtHex: string;
            isValid: boolean;
            isFinished: boolean;
            finalHex?: string;
        };
        error?: string;
    }>{
        return this.http.post<{
            data?: {
            psbtHex: string;
            isValid: boolean;
            isFinished: boolean;
            finalHex?: string;
        };
            error?: string;  
        }>(this.apiUrl + 'sign-psbt', { ...buildPsbtConfig, network })
    }
}
