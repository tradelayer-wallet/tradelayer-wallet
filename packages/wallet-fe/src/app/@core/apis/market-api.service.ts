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

    // Drop /ws if present
    let cleanUrl = url.replace(/\/ws$/, '');

    // Replace protocol
    if (cleanUrl.startsWith('ws://')) return cleanUrl.replace(/^ws:/, 'http:');
    if (cleanUrl.startsWith('wss://')) return cleanUrl.replace(/^wss:/, 'https:');

    return cleanUrl;
}



    private get apiUrl() {
        console.log('loading markets '+this.orderbookUrl + '/markets/')
        // if (!this.NETWORK) return null;
        if (!this.orderbookUrl) return null;
        const modUri = this.wsToHttp(this.orderbookUrl)
        return modUri + '/markets/';
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
