import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { environment } from "src/environments/environment";

@Injectable({
    providedIn: 'root',
})

export class NewTradeLayerApiService {
    constructor(
        private http: HttpClient,
    ) {}

    private get apiUrl() {
        return 'http:/localhost:1986' + '/tl/'
    }

    rpc(method: string, params?: any[] | any): Observable<{
        data?: any;
        error?: any;
    }> {
        if (!this.apiUrl) throw new Error("Api Url not found");
        const body = { params };
        return this.http.post<any>(this.apiUrl + method, body)
        .pipe(map((res: any) => {
            return { data: res };
        }))
    }
}
