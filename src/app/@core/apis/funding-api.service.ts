import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { environment } from '../../../environments/environment';
import { map } from 'rxjs/operators';

@Injectable({
    providedIn: 'root',
})

export class FundingApiService {

    constructor(
        private http: HttpClient
    ) {}

    private get apiUrl() {
        return environment.apiUrl + '/funding/'
    }

    fundAddress(address: string) {
        const params = { address };
        return this.http.get(this.apiUrl + 'address', { params });
    }
}
