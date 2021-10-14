import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { environment } from '../../../environments/environment';
import { map } from 'rxjs/operators';
import { TNETWORK } from "../services/rpc.service";

@Injectable({
    providedIn: 'root',
})

export class MarketApiService {
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
            ? environment.apiUrl + '/market/'
            : environment.apiUrlTestnet + '/market/';
    }

    getSpotMarkets() {
        return this.http.get(this.apiUrl + 'listMarkets')
            .pipe(map((res: any) => res.data));
    }

    getFuturesMarkets() {
        return this.http.get(this.apiUrl + 'listFuturesMarkets')
            .pipe(map((res: any) => res.data));
    }
}
