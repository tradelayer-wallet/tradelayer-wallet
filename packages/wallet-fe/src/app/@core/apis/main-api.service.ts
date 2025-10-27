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

     // New Function to initialize TradeLayer
    initTradeLayer(): Observable<any> {
        console.log('about to call init TL ' + this.apiUrl + 'init-tradelayer');
        return this.http.post(this.apiUrl + 'init-tradelayer', {});
    }

    // === ALGO API methods ===

   // main-api.service.ts (FE)
    uploadAlgo(body: { name: string; dataBase64: string }) {
      return this.http.post<{ ok: boolean; systemId: string }>(
        this.apiUrl + 'algo/upload',
        body
      );
    }

    runAlgo(body: {
          systemId: string;
          network: string;
          host: string;
          port: string;
          test: boolean;
          addr: string;
          pub: string;
        }): Observable<{ ok: boolean }> {
          return this.http.post<{ ok: boolean }>(this.apiUrl + 'algo/run', body);
        }

    stopAlgo(systemId: string): Observable<{ ok: boolean }> {
      console.log('stop algo route '+systemId)
      return this.http.post<{ ok: boolean }>(
        this.apiUrl + 'algo/stop',
        { systemId }
      );
    }

    fetchDiscovery(filters: any) {
      return this.http.get<any[]>(this.apiUrl + 'algo/discovery', { params: filters });
    }

    fetchRunning() {
        const running = this.http.get<any[]>(this.apiUrl + 'algo/running');
        console.log('running algos '+running)
      return running
    }

    allocate(body: { systemId: string; amount: number }) {
      return this.http.post(this.apiUrl + 'algo/allocate', body);
    }

    withdraw(body: { systemId: string; amount: number }) {
      return this.http.post(this.apiUrl + 'algo/withdraw', body);
    }

    metrics(runId: string) {
      return this.http.get(this.apiUrl + 'algo/metrics', { params: { runId } });
    }

    userTrades() {
      return new EventSource(this.apiUrl + 'algo/trades/stream', { withCredentials: true });
    }
}
