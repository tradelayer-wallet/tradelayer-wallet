import { Injectable } from "@angular/core";
// import { AddressService } from "../address.service";
import { ApiService } from "../api.service";
import { AuthService } from "../auth.service";
import { SocketService } from "../socket.service";


@Injectable({
    providedIn: 'root',
})

export class DealerService {
    private _myDealerTrades: any[] = [];

    constructor(
        private socketService: SocketService,
        // private addressService: AddressService,
        private apiService: ApiService,
        private authService: AuthService,
    ) {}

    get socket() {
        return this.socketService.socket;
    }

    get myDealerTrades() {
        return this._myDealerTrades;
    }

    set myDealerTrades(value: any) {
        this._myDealerTrades = value;
        this.emitDealerData();
    }

    get dealerStarted() {
        return !!this._myDealerTrades.length;
    }

    addToDealerTrades(newTrade: any) {
        const existing = this.myDealerTrades.find((t: any) => (
            t.propIdDesired === newTrade.propIdDesired &&
            t.propIdForSale === newTrade.propIdForSale &&
            t.price === newTrade.price
        ));
        if (existing) {
            existing.amount += newTrade.amount;
            this.resetDealerTrades();
        } else {
            this.myDealerTrades = [...this.myDealerTrades, newTrade];
        }
    }

    resetDealerTrades() {
        this.myDealerTrades = this.myDealerTrades;
    }

    private emitDealerData() {
        const address = this.authService.activeMainKey?.address;
        const pubkey = this.authService.activeMainKey?.pubkey;
        const data = { tradesData: this.myDealerTrades, addressPair: { address, pubkey } };
        if (!address || !pubkey || !this.myDealerTrades) return;
        // this.socket.emit('dealer-data', data);
    }
}
