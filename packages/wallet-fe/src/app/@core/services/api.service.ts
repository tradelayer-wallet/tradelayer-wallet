import { Injectable } from "@angular/core";
import { MainApiService } from "../apis/main-api.service";
import { KeysApiService } from "../apis/keys-api.service";
import { MarketApiService } from "../apis/market-api.service";
import { TradeLayerApiService } from "../apis/relayer-api.service";
import { TNETWORK } from "./rpc.service";
import { NewTradeLayerApiService } from "../apis/tl-api.service";


@Injectable({
    providedIn: 'root',
})

export class ApiService {
    private _network: TNETWORK = null;
    private _apiUrl: string | null = null;
    private _orderbookUrl: string | null = null;

    constructor(
        private marketApiService: MarketApiService,
        private mainApiService: MainApiService,
        private tradeLayerApiService: TradeLayerApiService,
        private keysApiService: KeysApiService,
        private newTLApiService: NewTradeLayerApiService,
    ) {}

    get network() {
        return this._network;
    }

    set network(value: TNETWORK) {
        this._network = value;
        this.keysApiService._setNETWORK(value);
        console.log(`NETWORK: ${value}`);
    }

    get apiUrl() {
        return this._apiUrl;
    }

    set apiUrl(value: string | null) {
        this._apiUrl = value;
        this.mainApi.setApiUrl(value).toPromise();
        this.tradeLayerApiService.setApiUrl(value);
        console.log(`API: ${value}`);
    }
    
    get orderbookUrl() {
        return this._orderbookUrl;
    }

    set orderbookUrl(value: string | null) {
        this._orderbookUrl = value;
        this.marketApi.setOrderbookUrl(value);
        console.log(`OB: ${value}`);
    }

    get marketApi(){ 
        return this.marketApiService;
    }

    get mainApi() {
        return this.mainApiService;
    }

    get tlApi() {
        return this.tradeLayerApiService;
    }

    get keysApi() {
        return this.keysApiService;
    }

    get newTlApi() {
        return this.newTLApiService;
    }
}
