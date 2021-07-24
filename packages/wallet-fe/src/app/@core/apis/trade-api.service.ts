import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { environment } from '../../../environments/environment';
import { map } from 'rxjs/operators';

@Injectable({
    providedIn: 'root',
})

export class TradeApiService {

    constructor(
        private http: HttpClient
    ) {}

    private get apiUrl() {
        return environment.apiUrl + '/trade/'
    }

    findDealerByTrade(trade: any) {
        const params = { trade: JSON.stringify(trade) };
        return this.http.get(this.apiUrl + 'getDealer', { params })
            .pipe(map((res: any) => res.data))
    }
}
