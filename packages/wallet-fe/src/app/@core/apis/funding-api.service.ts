import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { environment } from '../../../environments/environment';
import { TNETWORK } from "../services/rpc.service";

@Injectable({
    providedIn: 'root',
})

export class FundingApiService {
    private _NETWORK: TNETWORK = "LTC";

    constructor(
        private http: HttpClient
    ) {}

    get NETWORK() {
        return this._NETWORK;
    }

    set NETWORK(value: TNETWORK) {
        this._NETWORK = value;
    }

    private get apiUrl() {
        return this.NETWORK === "LTC"
            ? environment.apiUrl + '/funding/'
            : environment.apiUrlTestnet + '/funding/';
    }

    fundAddress(address: string) {
        const params = { address };
        return this.http.get(this.apiUrl + 'address', { params });
    }
}
