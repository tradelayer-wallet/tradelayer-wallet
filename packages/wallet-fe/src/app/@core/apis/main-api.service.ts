import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { environment } from "src/environments/environment";
import { ENetwork, TNETWORK } from "../services/rpc.service";
import { IBuildLTCITTxConfig, IBuildTxConfig, ISignPsbtConfig, ISignTxConfig } from "../services/txs.service";

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

    setApiUrl(apiUrl: string | null) {
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
        IECode: number;
        EECode: number;
    }> {
        const body = { method, params };
        return this.http.post<{
            data?: any;
            error?: string;
            statusCode: number;
            IECode: number;
            EECode: number;
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

    buildLTCITTx(buildTxConfig: IBuildLTCITTxConfig, isApiMode: boolean): Observable<{
        data?: { rawtx: string; inputs: any[]};
        error?: string;
    }>{
        return this.http.post<{
            data?: { rawtx: string; inputs: any[]};
            error?: string;  
        }>(this.apiUrl + 'build-ltcit-tx', { ...buildTxConfig, isApiMode })
    }


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

    getBitvmStatus(query?: { propertyId?: number; dlcRef?: string }): Observable<{
        data?: any;
        error?: string;
    }> {
        const params: string[] = [];
        if (query && Number.isFinite(query.propertyId) && Number(query.propertyId) > 0) {
            params.push(`propertyId=${Number(query.propertyId)}`);
        }
        if (query?.dlcRef) {
            params.push(`dlcRef=${encodeURIComponent(String(query.dlcRef).trim())}`);
        }
        const qs = params.length ? `?${params.join('&')}` : '';
        return this.http.get<{ data?: any; error?: string }>(this.apiUrl + `bitvm/status${qs}`);
    }

    bitvmWatchtowerTick(body?: { propertyId?: number; dlcRef?: string }): Observable<{
        data?: any;
        error?: string;
    }> {
        return this.http.post<{ data?: any; error?: string }>(this.apiUrl + 'bitvm/watchtower-tick', body || {});
    }

    bitvmEmitFraudProof(body?: { propertyId?: number; dlcRef?: string }): Observable<{
        data?: any;
        error?: string;
    }> {
        return this.http.post<{ data?: any; error?: string }>(this.apiUrl + 'bitvm/emit-fraud-proof', body || {});
    }

    getBitvmWatchtowerStatus(): Observable<{ data?: any; error?: string }> {
        return this.http.get<{ data?: any; error?: string }>(this.apiUrl + 'bitvm/watchtower/status');
    }

    bitvmWatchtowerStart(body?: { intervalMs?: number; autoFraudProof?: boolean; propertyId?: number; dlcRef?: string }): Observable<{
        data?: any;
        error?: string;
    }> {
        return this.http.post<{ data?: any; error?: string }>(this.apiUrl + 'bitvm/watchtower/start', body || {});
    }

    bitvmWatchtowerStop(): Observable<{ data?: any; error?: string }> {
        return this.http.post<{ data?: any; error?: string }>(this.apiUrl + 'bitvm/watchtower/stop', {});
    }

    bitvmWatchtowerScan(body?: { propertyId?: number; dlcRef?: string }): Observable<{ data?: any; error?: string }> {
        return this.http.post<{ data?: any; error?: string }>(this.apiUrl + 'bitvm/watchtower/scan', body || {});
    }
}
