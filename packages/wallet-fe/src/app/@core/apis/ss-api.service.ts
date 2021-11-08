import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { environment } from "src/environments/environment";
import { RPCCredentials } from "../services/rpc.service";
import { ITradeConf } from "../services/spot-services/trade.service";

@Injectable({
    providedIn: 'root',
})

export class SocketScriptApiService {

    constructor(
        private http: HttpClient
    ) {}

    private get apiUrl() {
        return environment.homeApiUrl + '/ss/'
    }

    rpcCall(command: string) {
        const params = { command };
        return this.http.get(this.apiUrl + 'rpcCall', { params });
    }

    checkWalletServer() {
        return this.http.get(this.apiUrl + 'checkConnection');
    }

    connect(creds: RPCCredentials) {
        const { username, password, port } = creds;
        const params = { user: username, pass: password, port };
        return this.http.get(this.apiUrl + 'connect', { params });
    }

    // startListener(address: string) {
    //     const params = { address };
    //     return this.http.get(this.apiUrl + 'listStart', { params });
    // }

    // stopListener() {
    //     return this.http.get(this.apiUrl + 'listStop');
    // }

    // initTrade(trade: ITradeConf, keyPair: any) {
    //     const params = { trade: JSON.stringify(trade), keyPair: JSON.stringify(keyPair)};
    //     return this.http.get(this.apiUrl + 'initTrade', { params });
    // }

    postInitTrade(trade: ITradeConf, keyPair: any) {
        const body = { trade, keyPair };
        return this.http.post(this.apiUrl + 'initTrade', body);
    }

    startWalletNode(directory: string, isTestNet: boolean): Observable<{
        error: string;
        data: any;
        action?: number;
    }> {
        const params: { isTestNet: boolean; directory?: string } = {
            isTestNet,
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

    extractKeyPairFromPrivKey(privKey: string): Observable<any> {
        const params = { privKey };
        return this.http.get<any>(this.apiUrl + 'extractKeyPairFromPrivKey', { params });
    }

    withdraw(fromAddress: string, toAddress: string, amount: number): Observable<{ error: any; data: string }> {
        const params = { fromAddress, toAddress, amount };
        return this.http.get<{ error: any; data: string }>(this.apiUrl + 'withdraw', { params });
    }

    saveConfigFile(isTestNet: boolean) {
        const params = { isTestNet };
        return this.http.get<{ error: any; data: string }>(this.apiUrl + 'saveConfigFile', { params });
    }
}
