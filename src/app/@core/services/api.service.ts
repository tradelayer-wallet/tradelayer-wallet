import { Injectable } from "@angular/core";
import { MarketApiService } from "../apis/market-api.service";


@Injectable({
    providedIn: 'root',
})

export class ApiService {

    constructor(
        private marketApiService: MarketApiService,
    ) {}

    get marketApi(){ 
        return this.marketApiService;
    }
}
