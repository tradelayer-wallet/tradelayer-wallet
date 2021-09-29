import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";

export type TNETWORK = 'LTC' | 'LTCTEST';

@Injectable({
    providedIn: 'root',
})

export class SoChainApiService {
    private _NETWORK: TNETWORK = "LTC";

    constructor(
        private http: HttpClient,
    ) {}

    private get apiUrl() {
        return 'https://sochain.com/api/v2/';
    }

    get NETWORK() {
        return this._NETWORK;
    }

    set NETWORK(value: TNETWORK) {
        this._NETWORK = value;
    }

    getTxUnspents(address: string) {
        const url = `${this.apiUrl}get_tx_unspent/${this.NETWORK}/`;
        return this.http.get(url + address);
    }

    getNetworkInfo(): Observable<{
        status: string;
        data: any;
    }> {
        return this.http.get<{
            status: string;
            data: any;
        }>(this.apiUrl + 'get_info/' + this.NETWORK);
    }
}
