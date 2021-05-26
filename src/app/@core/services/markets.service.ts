import { Injectable } from "@angular/core";

export interface IMarketType {
    name: string,
    markets: any[],
    icon: string,
    disabled: boolean,
}

export interface IMarket {
    pair: string,
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
                    name: 'LTC/ID1',
                    disabled: false,
                },
                {
                    name: 'LTC/ID2',
                    disabled: false,
                },
                {
                    name: 'LTC/ID3',
                    disabled: false,
                },
                {
                    name: 'LTC/ID4',
                    disabled: false,
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
                    name: 'ALL/ID1',
                    disabled: false,
                },
                {
                    name: 'ALL/ID2',
                    disabled: false,
                },
                {
                    name: 'ALL/ID3',
                    disabled: false,
                },
            ],
            icon: 'https://cdn.discordapp.com/attachments/749975407838888058/817037799739490344/ALLFancyLogo.png',
            disabled: false,
        }
    ];

    private _selectedMarketType: IMarketType = this.marketsTypes[0];

    constructor() {}

    get marketsTypes() {
        return this._marketsTypes;
    }

    get selectedMarketType() {
        return this._selectedMarketType;
    }
    
    set selectedMarketType(value: IMarketType) {
        this._selectedMarketType = value;
    }

    get marketsFromSelectedMarketType() {
        return this.selectedMarketType.markets;
    }
}
