import { Injectable } from "@angular/core";
import { ApiService } from "../api.service";
import { SocketService } from "../socket.service";

export interface IFuturesMarketType {
    name: string,
    markets: IFutureMarket[],
    icon: string,
    disabled: boolean,
}

export interface IFutureMarket {
    first_token: IToken;
    second_token: IToken;
    disabled: boolean,
    pairString: string;
    contractName: string;
    contractId: number;
    collateral: number;
}

export interface IToken {
    shortName: string;
    fullName: string;
    propertyId: number;
}

@Injectable({
    providedIn: 'root',
})

export class FuturesMarketService {

    private _futuresMarketsTypes: IFuturesMarketType[] = [];

    private _selectedMarketType: IFuturesMarketType = this.futuresMarketsTypes[0] || null;
    private _selectedMarket: IFutureMarket = this.selectedMarketType?.markets[0] || null;

    constructor(
        private apiService: ApiService,
        private socketService: SocketService,
    ) { }

    get futuresMarketsTypes() {
        return this._futuresMarketsTypes;
    }

    get selectedMarketType(): IFuturesMarketType {
        return this._selectedMarketType;
    }
    
    set selectedMarketType(value: IFuturesMarketType) {
        if (!this.futuresMarketsTypes.length) return;
        this._selectedMarketType = value;
        this.selectedMarket = this.marketsFromSelectedMarketType.find(e => !e.disabled) || this.marketsFromSelectedMarketType[0];
    }

    get selectedMarketTypeIndex() {
        return this.futuresMarketsTypes.indexOf(this.selectedMarketType);
    }

    get marketsFromSelectedMarketType(): IFutureMarket[] {
        if (!this.futuresMarketsTypes.length) return [];
        return this.selectedMarketType.markets;
    }

    get selectedMarket(): IFutureMarket {
        return this._selectedMarket;
    }

    set selectedMarket(value: IFutureMarket) {
        this._selectedMarket = value;
        this.changeOrderbookMarketFilter();
    }

    get selectedMarketIndex() {
        return this.marketsFromSelectedMarketType.indexOf(this.selectedMarket);
    }

    get socket() {
        return this.socketService.socket;
    }
    
    get marketFilter() {
        return {
            type: 'SPOT',
            first_token: this.selectedMarket.first_token.propertyId,
            second_token: this.selectedMarket.second_token.propertyId,
        };
    };

    getMarkets() {
        this.apiService.marketApi.getFuturesMarkets()
            .subscribe((marketTypes: IFuturesMarketType[]) => {
                this._futuresMarketsTypes = marketTypes;
                this.selectedMarketType = marketTypes.find(e => !e.disabled) || marketTypes[0];
            });
    }

    private changeOrderbookMarketFilter() {
        this.socket.emit('update-orderbook', this.marketFilter);
    }
}
