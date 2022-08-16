import { Injectable } from "@angular/core";
import { MainApiService } from "../apis/main-api.service";
import { KeysApiService } from "../apis/keys-api.service";
// import { MarketApiService } from "../apis/market-api.service";
// import { SoChainApiService } from "../apis/sochain-api.service";
// import { SocketScriptApiService } from "../apis/ss-api.service";
import { TradeLayerApiService } from "../apis/relayer-api.service";
import { TNETWORK } from "./rpc.service";
// import { TNETWORK } from "./rpc.service";


@Injectable({
    providedIn: 'root',
})

export class ApiService {

    constructor(
        // private marketApiService: MarketApiService,
        // private soChainApiService: SoChainApiService,
        private mainApiService: MainApiService,
        private tradeLayerApiService: TradeLayerApiService,
        private keysApiService: KeysApiService,
    ) {}

    _setNETOWRK(value: TNETWORK) {
        // this.marketApi._setNETWORK(value);
        // this.soChainApi._setNETWORK(value);
        this.tradeLayerApiService._setNETWORK(value);
        this.keysApiService._setNETWORK(value);
        this.mainApi.setNETWORK(value).toPromise();
    }

    // get marketApi(){ 
    //     return this.marketApiService;
    // }

    // get soChainApi() {
    //     return this.soChainApiService;
    // }

    get mainApi() {
        return this.mainApiService;
    }

    get tlApi() {
        return this.tradeLayerApiService;
    }

    get keysApi() {
        return this.keysApiService;
    }
}
