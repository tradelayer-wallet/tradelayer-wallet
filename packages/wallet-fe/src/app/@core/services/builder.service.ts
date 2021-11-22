import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { ApiService } from "./api.service";


@Injectable({
    providedIn: 'root',
})

export class BuilderService {

    constructor(
        private apiService: ApiService,
    ) {}

    get ssApi() {
        return this.apiService.socketScriptApi;
    }

    build(txInfo: any) {
        return this.ssApi.build(txInfo)
    }
}
