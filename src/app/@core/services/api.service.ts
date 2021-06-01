import { Injectable } from "@angular/core";
import { MarketApiService } from "../apis/market-api.service";
import { SoChainApiService } from "../apis/sochain-api.service";


@Injectable({
    providedIn: 'root',
})

export class ApiService {

    constructor(
        private marketApiService: MarketApiService,
        private soChainApiService: SoChainApiService,
    ) {}

    get marketApi(){ 
        return this.marketApiService;
    }

    get soChainApi() {
        return this.soChainApiService;
    }
}
