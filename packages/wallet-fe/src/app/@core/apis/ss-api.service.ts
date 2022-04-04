import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { environment } from "src/environments/environment";
import { RPCCredentials } from "../services/rpc.service";

@Injectable({
    providedIn: 'root',
})

export class SocketScriptApiService {

    constructor(
        private http: HttpClient,
    ) {}

    private get apiUrl() {
        return environment.homeApiUrl + '/ss/'
    }

    rpcCall(command: string) {
        const params = { command };
        return this.http.get(this.apiUrl + 'rpcCall', { params });
    }

    postRpcCall(method: string, params: any): Observable<{
        data: any;
        error: any;
    }> {
        const body = params;
        const url = this.apiUrl + 'rpcCall/' + method;
        return this.http.post<{
            data: any;
            error: any;
        }>(url, body);
    }

    checkWalletServer() {
        return this.http.get(this.apiUrl + 'checkConnection');
    }

    connect(creds: RPCCredentials) {
        const { username, password, port } = creds;
        const params = { user: username, pass: password, port };
        return this.http.get(this.apiUrl + 'connect', { params });
    }

    // postInitTrade(trade: ITradeConf | IContractTradeConf, keyPair: any) {
    //     const body = { trade, keyPair };
    //     return this.http.post(this.apiUrl + 'initTrade', body);
    // }

    startWalletNode(
            directory: string,
            isTestNet: boolean,
            flags: { reindex: boolean; startclean: boolean },
            startWithOffline: boolean,
        ): Observable<{
        error: string;
        data: any;
        action?: number;
    }> {
        const { reindex, startclean } = flags;
        const params: { 
            isTestNet: boolean; 
            directory?: string;
            reindex: boolean;
            startclean: boolean;
            startWithOffline: boolean,
        } = {
            isTestNet,
            startclean,
            reindex,
            startWithOffline,
        };
        if (directory) params.directory = directory;
        return this.http.get<{
            error: string;
            data: any;
            action?: number;
        }>(this.apiUrl + 'startWalletNode', { params });
    }

    createNewNode(creds: { username: string, password: string, port: number, path: string }): Observable<{
        error: string;
        data: any;
    }> {
        const params = creds;
        return this.http.get< {
            error: string;
            data: any;
        }>(this.apiUrl + 'createNewNode', { params });
    }

    // extractKeyPairFromPrivKey(privKey: string): Observable<any> {
    //     const params = { privKey };
    //     return this.http.get<any>(this.apiUrl + 'extractKeyPairFromPrivKey', { params });
    // }

    withdraw(fromAddress: string, toAddress: string, amount: number): Observable<{ error: any; data: string }> {
        const params = { fromAddress, toAddress, amount };
        return this.http.get<{ error: any; data: string }>(this.apiUrl + 'withdraw', { params });
    }

    saveConfigFile(isTestNet: boolean) {
        const params = { isTestNet };
        return this.http.get<{ error: any; data: string }>(this.apiUrl + 'saveConfigFile', { params });
    }

    build(txInfo: any) {
        const { fromAddress, toAddress, amount, txType, inputs, propId, block, featureid, minclientversion } = txInfo;
        const body: any = { fromAddress, toAddress, amount, txType, propId, block, featureid, minclientversion };
        if (inputs.length) body.inputs = JSON.stringify(inputs);
        return this.http.post<{error: any; data: any }>(this.apiUrl + 'buildTx', body);
    }

    terminate() {
        return this.http.get<{error: any; data: any }>(this.apiUrl + 'terminate');
    }

    startLiquidityScript(options: any): Observable<any> {
        const body = { ...options };
        return this.http.post<{error: any; data: any }>(this.apiUrl + 'runLiquidityScript', body);
    }

    stopLiquidityScript(address: string): Observable<any> {
        const body = { address };
        return this.http.post<{error: any; data: any }>(this.apiUrl + 'stopLiquidityScript', body);
    }
}
