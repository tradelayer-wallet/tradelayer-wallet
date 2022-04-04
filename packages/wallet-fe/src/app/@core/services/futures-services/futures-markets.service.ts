import { Injectable } from "@angular/core";
import { ApiService } from "../api.service";
import { SocketService } from "../socket.service";


export interface IFuturesMarketType {
    name: string;
    markets: IContract[];
    icon: string;
    disabled: boolean;
}

export interface IContract {
    contractId: number;
    contractName: string;
    first_token: IContractPart;
    second_token: IContractPart;
    disabled: boolean;
    pairString: string;
}

export interface IContractPart {
    shortName: string;
    fullName: string;
}

@Injectable({
    providedIn: 'root',
})

export class FuturesMarketsService {

    private _futuresMarketsTypes: IFuturesMarketType[] = [];

    private _selectedFuturesMarketType: IFuturesMarketType = this.futuresMarketsTypes[0] || null;
    private _selectedContract: IContract = this.selectedFuturesMarketType?.markets[0] || null;

    constructor(
        private apiService: ApiService,
        private socketServic: SocketService,
    ) { }
    
    get socket() {
        return this.socketServic.socket;
    }

    get futuresMarketsTypes() {
        return this._futuresMarketsTypes;
    }

    get selectedFuturesMarketType(): IFuturesMarketType {
        return this._selectedFuturesMarketType;
    }
    
    set selectedFuturesMarketType(value: IFuturesMarketType) {
        if (!this.futuresMarketsTypes.length) return;
        this._selectedFuturesMarketType = value;
        this.selectedContract = this.contractsFromSelectedFuturesMarketType[0];
    }

    get contractsFromSelectedFuturesMarketType(): IContract[] {
        if (!this.futuresMarketsTypes.length) return [];
        return this.selectedFuturesMarketType.markets;
    }
    get selectedFutururesMarketTypeIndex() {
        return this.futuresMarketsTypes.indexOf(this.selectedFuturesMarketType);
    }

    get selectedContract(): IContract {
        return this._selectedContract;
    }

    set selectedContract(value: IContract) {
        this._selectedContract = value;
        this.changeOrderbookContractFilter(value);
    }

    get selectedContractIndex() {
        return this.contractsFromSelectedFuturesMarketType.indexOf(this.selectedContract);
    }

    get marketFilter() {
        return {
            type: 'FUTURES',
            contractId: this.selectedContract.contractId,
        };
    };

    getMarkets() {
        this.apiService.marketApi.getFuturesMarkets()
            .subscribe((futuresMarketTypes: IFuturesMarketType[]) => {
                this._futuresMarketsTypes = futuresMarketTypes;
                this.selectedFuturesMarketType = this._futuresMarketsTypes[0];
            });
    }

    private changeOrderbookContractFilter(_contract: IContract) {
        this.socket.emit('update-orderbook', this.marketFilter);
    }
}
