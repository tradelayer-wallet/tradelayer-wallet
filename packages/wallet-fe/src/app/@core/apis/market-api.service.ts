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

    private wsToHttp(url: string | null): string | null {
    if (!url) return null;
    if (url.startsWith('ws://')) return url.replace(/^ws:/, 'http:');
    if (url.startsWith('wss://')) return url.replace(/^wss:/, 'https:');
    return url;
    }


    private get apiUrl() {
        console.log('loading markets '+this.orderbookUrl + '/markets/')
        // if (!this.NETWORK) return null;
        if (!this.orderbookUrl) return null;
        return this.orderbookUrl + '/markets/';
    }

    setOrderbookUrl(value: string | null) {
        this.orderbookUrl = this.wsToHttp(value);
    }

    // _setNETWORK(value: TNETWORK) {
    //     this.NETWORK = value;
    // }

    getSpotMarkets() {
        console.log('spot markets '+this.apiUrl + 'spot')
        if (!this.apiUrl) throw new Error("No Api Url found");
        return this.http.get(this.apiUrl + 'spot')
            .pipe(map((res: any) => res.data));
    }

    getFuturesMarkets() {    
        console.log('futures markets '+this.apiUrl + 'futures')
        if (!this.apiUrl) throw new Error("No Api Url found");
        return this.http.get(this.apiUrl + 'futures')
            .pipe(map((res: any) => res.data));
    }
}
