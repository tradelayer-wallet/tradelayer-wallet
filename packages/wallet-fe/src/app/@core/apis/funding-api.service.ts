import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { environment } from '../../../environments/environment';
import { TNETWORK } from "../services/rpc.service";

@Injectable({
    providedIn: 'root',
})

export class FundingApiService {
    private NETWORK: TNETWORK = "LTC";

    constructor(
        private http: HttpClient,
    ) {}

    private get apiUrl() {
        return this.NETWORK === "LTC"
            ? environment.orderbook_service_url + '/funding/'
            : environment.orderbook_service_url_testnet + '/funding/';
    }

    _setNETWORK(value: TNETWORK) {
        this.NETWORK = value;
    }

    // fundAddress(address: string) {
    //     const params = { address };
    //     return this.http.get(this.apiUrl + 'address', { params });
    // }
}
