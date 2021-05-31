import { Injectable } from "@angular/core";

export interface IMarketType {
    name: string,
    markets: IMarket[],
    icon: string,
    disabled: boolean,
}

export interface IMarket {
    name: string;
    disabled: boolean;
    F_tokenName: string,
    S_tokenName: string,
}

@Injectable({
    providedIn: 'root',
})

export class MarketsService {

    private _marketsTypes: IMarketType[] = [
        {
            name: 'LTC',
            markets: [
                {
                    name: 'ID1/LTC',
                    disabled: false,
                    F_tokenName: 'ID1',
                    S_tokenName: 'LTC'
                },
                {
                    name: 'ID2/LTC',
                    disabled: false,
                    F_tokenName: 'ID2',
                    S_tokenName: 'LTC'
                },
                {
                    name: 'ID3/LTC',
                    disabled: false,
                    F_tokenName: 'ID3',
                    S_tokenName: 'LTC'
                },
                {
                    name: 'ID4/LTC',
                    disabled: false,
                    F_tokenName: 'ID4',
                    S_tokenName: 'LTC'
                },
            ],
            icon: 'https://bitcoin-capital.bg/wp-content/uploads/2019/07/1920px-LTC-400-min-300x300.png',
            disabled: false,
        },
        {
            name: 'USD',
            markets: [],
            icon: 'https://cdn0.iconfinder.com/data/icons/mobile-device/512/dollar-usd-round-keyboard-money-usa-latin-2-512.png',
            disabled: true,

        },
        {
            name: 'ALL',
            markets: [
                {
                    name: 'ID1/ALL',
                    disabled: false,
                    F_tokenName: 'ID1',
                    S_tokenName: 'ALL'
                },
                {
                    name: 'ID2/ALL',
                    disabled: false,
                    F_tokenName: 'ID2',
                    S_tokenName: 'ALL'
                },
                {
                    name: 'ID3/ALL',
                    disabled: false,
                    F_tokenName: 'ID3',
                    S_tokenName: 'ALL'
                },
            ],
            icon: 'https://cdn.discordapp.com/attachments/749975407838888058/817037799739490344/ALLFancyLogo.png',
            disabled: false,
        }
    ];

    private _selectedMarketType: IMarketType = this.marketsTypes[0];
    private _selectedMarket: IMarket = this.selectedMarketType.markets[0];

    constructor() {}

    get marketsTypes() {
        return this._marketsTypes;
    }

    get selectedMarketType(): IMarketType {
        return this._selectedMarketType;
    }
    
    set selectedMarketType(value: IMarketType) {
        this._selectedMarketType = value;
        this._selectedMarket = this.marketsFromSelectedMarketType[0];
    }

    get marketsFromSelectedMarketType(): IMarket[] {
        return this.selectedMarketType.markets;
    }

    get selectedMarket(): IMarket {
        return this._selectedMarket;
    }

    set selectedMarket(value: IMarket) {
        this._selectedMarket = value;
    }
}
