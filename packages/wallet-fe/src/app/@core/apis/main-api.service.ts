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
}
