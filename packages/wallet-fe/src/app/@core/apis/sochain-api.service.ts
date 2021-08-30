import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { environment } from '../../../environments/environment';
import { map } from 'rxjs/operators';
import { Observable } from "rxjs";

@Injectable({
    providedIn: 'root',
})

export class SoChainApiService {

    constructor(
        private http: HttpClient
    ) {}

    private get apiUrl() {
        return 'https://sochain.com/api/v2/';
    }

    private get NETWORK(): string {
        return environment.network
    }

    getAddressBalance(address: string) {
        const url = `${this.apiUrl}get_address_balance/${this.NETWORK}/`;
        return this.http.get(url + address);
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
