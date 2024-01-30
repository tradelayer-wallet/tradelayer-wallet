import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";

@Injectable({
    providedIn: 'root',
})

export class NewTradeLayerApiService {
    private apiUrl: string = 'http://localhost:3000';

    constructor(
        private http: HttpClient,
    ) {}

    private get apiURL() {
        if (!this.apiUrl) return null;
        return this.apiUrl;
    }

    rpc(method: string, params?: any[] | any): Observable<{
        data?: any;
        error?: any;
    }> {
        if (!this.apiURL) throw new Error("Api Url not found");
        const body = { params };
        return this.http.post<any>(this.apiURL + '/' + method, body)
        .pipe(map((res: any) => {
            return { data: res };
        }))
    }
}
