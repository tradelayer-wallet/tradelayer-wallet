import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { environment } from "src/environments/environment";
import { ENetwork } from "../services/rpc.service";
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

    // postRpcCall(method: string, params: any): Observable<{
    //     data: any;
    //     error: any;
    // }> {
    //     const body = params;
    //     const url = this.apiUrl + 'rpcCall/' + method;
    //     return this.http.post<{
    //         data: any;
    //         error: any;
    //     }>(url, body);
    // }

    // connect(creds: RPCCredentials) {
    //     const { username, password, port } = creds;
    //     const params = { user: username, pass: password, port };
    //     return this.http.get(this.apiUrl + 'connect', { params });
    // }

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

    rpcCall(method: string, params?: any[]): Observable<any> {
        const body = { method, params };
        return this.http.post(this.apiUrl + 'rpc-call', body)
    }
    // createNewNode(creds: { username: string, password: string, port: number, path: string }): Observable<{
    //     error: string;
    //     data: any;
    // }> {
    //     const params = creds;
    //     return this.http.get< {
    //         error: string;
    //         data: any;
    //     }>(this.apiUrl + 'createNewNode', { params });
    // }

    // withdraw(fromAddress: string, toAddress: string, amount: number): Observable<{ error: any; data: string }> {
    //     const params = { fromAddress, toAddress, amount };
    //     return this.http.get<{ error: any; data: string }>(this.apiUrl + 'withdraw', { params });
    // }

    // saveConfigFile(isTestNet: boolean) {
    //     const params = { isTestNet };
    //     return this.http.get<{ error: any; data: string }>(this.apiUrl + 'saveConfigFile', { params });
    // }

    // build(txInfo: any) {
    //     const { fromAddress, toAddress, amount, txType, inputs, propId, block, featureid, minclientversion } = txInfo;
    //     const body: any = { fromAddress, toAddress, amount, txType, propId, block, featureid, minclientversion };
    //     if (inputs.length) body.inputs = JSON.stringify(inputs);
    //     return this.http.post<{error: any; data: any }>(this.apiUrl + 'buildTx', body);
    // }

    // terminate() {
    //     return this.http.get<{error: any; data: any }>(this.apiUrl + 'terminate');
    // }

    // startLiquidityScript(options: any): Observable<any> {
    //     const body = { ...options };
    //     return this.http.post<{error: any; data: any }>(this.apiUrl + 'runLiquidityScript', body);
    // }

    // stopLiquidityScript(address: string): Observable<any> {
    //     const body = { address };
    //     return this.http.post<{error: any; data: any }>(this.apiUrl + 'stopLiquidityScript', body);
    // }
}
