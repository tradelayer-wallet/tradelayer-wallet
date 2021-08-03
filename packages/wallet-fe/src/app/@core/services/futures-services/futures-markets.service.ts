import { Injectable } from "@angular/core";
import { ApiService } from "../api.service";
import { SocketService } from "../socket.service";


export interface IMarketType {
    name: string,
    markets: IMarket[],
    icon: string,
    disabled: boolean,
}

export interface IMarket {
    first_token: IToken;
    second_token: IToken;
    disabled: boolean,
    pairString: string;
}

export interface IToken {
    shortName: string;
    fullName: string;
    propertyId: number;
}

const ltcIcon = 'https://bitcoin-capital.bg/wp-content/uploads/2019/07/1920px-LTC-400-min-300x300.png';
const btcIcon = 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/BTC_Logo.svg/2000px-BTC_Logo.svg.png';
const dogeIcon = 'https://logos-download.com/wp-content/uploads/2018/04/DogeCoin_logo_cercle-700x700.png';

const FuturesMarkets: any = [
    {
        name: 'LTC',
        markets: [
            {
                first_token: {
                    shortName: 'LTC',
                    fullName: 'Litecoin',
                    propertyId: 999,
                },
                second_token: {
                    shortName: 'USD',
                    fullName: 'United State Dollar',
                    propertyId: 998,
                },
                disabled: false,
                pairString: 'LTC/USD',
            }
        ],
        icon: ltcIcon,
        disabled: false,
    },
    {
        name: 'BTC',
        markets: [],
        icon: btcIcon,
        disabled: true,
    },
    {
        name: 'DOGE',
        markets: [],
        icon: dogeIcon,
        disabled: true,
    }
];

@Injectable({
    providedIn: 'root',
})

export class FuturesMarketsService {

    private _marketsTypes: IMarketType[] = [];

    private _selectedMarketType: IMarketType = this.marketsTypes[0] || null;
    private _selectedMarket: IMarket = this.selectedMarketType?.markets[0] || null;

    constructor(
        private apiService: ApiService,
        private socketServic: SocketService,
    ) {
        this.getMarkets();
        this.socket.on('server_connect', () => {
            this.getMarkets();
        });
    }

    get marketsTypes() {
        return this._marketsTypes;
    }

    get selectedMarketType(): IMarketType {
        return this._selectedMarketType;
    }
    
    set selectedMarketType(value: IMarketType) {
        if (!this.marketsTypes.length) return;
        this._selectedMarketType = value;
        this.selectedMarket = this.marketsFromSelectedMarketType[0];
    }

    get selectedMarketTypeIndex() {
        return this.marketsTypes.indexOf(this.selectedMarketType);
    }

    get marketsFromSelectedMarketType(): IMarket[] {
        if (!this.marketsTypes.length) return [];
        return this.selectedMarketType.markets;
    }

    get selectedMarket(): IMarket {
        return this._selectedMarket;
    }

    set selectedMarket(value: IMarket) {
        this._selectedMarket = value;
        // this.changeOrderbookMarketFilter(value);
    }

    get selectedMarketIndex() {
        return this.marketsFromSelectedMarketType.indexOf(this.selectedMarket);
    }

    get socket() {
        return this.socketServic.socket;
    }

    getMarkets() {
        // this.apiService.marketApi.getMarkets()
        //     .subscribe((marketTypes: IMarketType[]) => {
        //         this._marketsTypes = marketTypes;
        //         this.selectedMarketType = marketTypes[0];
        //     });
        this._marketsTypes = FuturesMarkets;
        this.selectedMarketType = FuturesMarkets[0];
    }

    private changeOrderbookMarketFilter(market: IMarket) {
        const marketFilter = {
            firstId: market.first_token.propertyId,
            secondId: market.second_token.propertyId,
        };
        this.socket.emit('orderbook-market-filter', marketFilter);
    }
}
