import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { environment } from "src/environments/environment";
import { TNETWORK } from "../services/rpc.service";


@Injectable({
    providedIn: 'root',
})

export class TradeLayerApiService {
    // private NETWORK: TNETWORK = null;
    private apiUrl: string | null = null;

    constructor(
        private http: HttpClient,
    ) {}

    private get apiURL() {
        if (!this.apiUrl) return null;
        return this.apiUrl;
    }

    setApiUrl(value: string | null) {
        this.apiUrl = value;
    }

    rpc(method: string, params?: any[]): Observable<{
        data?: any;
        error?: any;
    }> {
        if (!this.apiURL) throw new Error("Api Url not found");
        const body = { params };
        return this.http.post<{
            data?: any;
            error?: any;
        }>(this.apiURL + '/rpc/' + method, body);
    }

    validateAddress(address: string): Observable<{
        data?: any;
        error?: any;
    }>  {
        return this.http.get<{
            data?: any;
            error?: any
        }>(this.apiURL + '/address/validate/' + address);
    }

    fundTestnetAddress(address: string): Observable<{
        data?: any;
        error?: any;
    }>  {
        return this.http.get<{
            data?: any;
            error?: any
        }>(this.apiURL + '/address/faucet/' + address);
    }
}
