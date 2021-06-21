import { Injectable } from "@angular/core";
import { FundingApiService } from "../apis/funding-api.service";
import { MarketApiService } from "../apis/market-api.service";
import { SoChainApiService } from "../apis/sochain-api.service";


@Injectable({
    providedIn: 'root',
})

export class ApiService {

    constructor(
        private marketApiService: MarketApiService,
        private fundingApiService: FundingApiService,
        private soChainApiService: SoChainApiService,
    ) {}

    get marketApi(){ 
        return this.marketApiService;
    }

    get soChainApi() {
        return this.soChainApiService;
    }

    get fundingApi() {
        return this.fundingApiService;
    }
}
