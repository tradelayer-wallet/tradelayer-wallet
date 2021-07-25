import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { environment } from "src/environments/environment";
import { RPCCredentials } from "../services/rpc.service";

@Injectable({
    providedIn: 'root',
})

export class SocketScriptApiService {

    constructor(
        private http: HttpClient
    ) {}

    private get apiUrl() {
        return environment.homeApiUrl + '/ss/'
    }

    connect(creds: RPCCredentials) {
        const { username, password } = creds;
        const params = { user: username, pass: password };
        return this.http.get(this.apiUrl + 'connect', { params });
    }
}
