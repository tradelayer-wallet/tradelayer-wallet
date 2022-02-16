import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { TNETWORK } from "../services/rpc.service";


@Injectable({
    providedIn: 'root',
})

export class SoChainApiService {
    private NETWORK: TNETWORK = "LTC";

    constructor(
        private http: HttpClient
    ) {}

    private get apiUrl() {
        return 'https://sochain.com/api/v2/';
    }

    _setNETWORK(value: TNETWORK) {
        this.NETWORK = value;
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
