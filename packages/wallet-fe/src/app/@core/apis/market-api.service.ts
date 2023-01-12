import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { map } from 'rxjs/operators';
// import { TNETWORK } from "../services/rpc.service";

@Injectable({
    providedIn: 'root',
})

export class MarketApiService {
    // private NETWORK: TNETWORK = null;
    private orderbookUrl: string | null = null;

    constructor(
        private http: HttpClient,
    ) {}

    private get apiUrl() {
        // if (!this.NETWORK) return null;
        if (!this.orderbookUrl) return null;
        return this.orderbookUrl + '/markets/';
    }

    setOrderbookUrl(value: string | null) {
        this.orderbookUrl = value;
    }

    // _setNETWORK(value: TNETWORK) {
    //     this.NETWORK = value;
    // }

    getSpotMarkets() {
        if (!this.apiUrl) throw new Error("No Api Url found");
        return this.http.get(this.apiUrl + 'spot')
            .pipe(map((res: any) => res.data));
    }

    getFuturesMarkets() {
        if (!this.apiUrl) throw new Error("No Api Url found");
        return this.http.get(this.apiUrl + 'futures')
            .pipe(map((res: any) => res.data));
    }
}
