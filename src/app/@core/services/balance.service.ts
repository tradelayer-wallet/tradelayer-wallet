import { Injectable } from "@angular/core";
import { AddressService } from "./address.service";
import { ApiService } from "./api.service";


@Injectable({
    providedIn: 'root',
})

export class BalanceService {
    private _addressesBalance: any = {};

    constructor(
        private addressService: AddressService,
        private apiServic: ApiService,
    ) {}

    get soChainApi() {
        return this.apiServic.soChainApi;
    }

    get activeAddress() {
        return this.addressService.activeKeyPair?.address
    }

    get addressesBalance() {
        return this._addressesBalance
    }

    async updateLtcBalanceForAddress(address: string) {
        this._addressesBalance[address] = {};
        const balanceRes: any = await this.soChainApi.getAddressBalance(address).toPromise();
        if (!balanceRes.data || balanceRes.status !== 'success') return;
        const { unconfirmed_balance, confirmed_balance } = balanceRes.data;
        this._addressesBalance[address] = { unconfirmed_balance, confirmed_balance };
    }
}
