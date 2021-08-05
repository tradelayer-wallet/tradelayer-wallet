import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { environment } from '../../../environments/environment';
import { map } from 'rxjs/operators';

@Injectable({
    providedIn: 'root',
})

export class MarketApiService {

    constructor(
        private http: HttpClient
    ) {}

    private get apiUrl() {
        return environment.apiUrl + '/market/'
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
