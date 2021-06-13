import { Injectable } from "@angular/core";
import { AddressService } from "./address.service";
import { ApiService } from "./api.service";
import { RpcService } from "./rpc.service";
import { SocketService } from "./socket.service";

export interface ICryptoBalance {
    address: string;
    confirmed: number;
    unconfirmed: number;
    total: number
}

export interface ITokensBalance {
    name?: string,
    propertyid: number;
    balance: number;
    reserve: number;
}
  
@Injectable({
    providedIn: 'root',
})

export class BalanceService {
    private _addressesBalance: any = {};
    private _addressesTokensBalance: any = {};

    constructor(
        private apiServic: ApiService,
        private rpcServic: RpcService,
        private addressService: AddressService,
        private socketService: SocketService,
    ) {
        this.handleSocketEvents()
    }

    private get soChainApi() {
        return this.apiServic.soChainApi;
    }

    get addressesBalance() {
        return this._addressesBalance
    }

    get selectedAddress() {
        return this.addressService.activeKeyPair?.address;
    }

    get addressesTokensBalanceForAddress(): ITokensBalance[] | [] {
        if (!this.selectedAddress) return [];
        return this._addressesTokensBalance[this.selectedAddress];
    }

    get structuredLTCBalances(): ICryptoBalance[] {
        return Object.keys(this._addressesBalance).map((address) => ({
            address,
            confirmed: parseFloat(this._addressesBalance[address].confirmed_balance),
            unconfirmed: parseFloat(this._addressesBalance[address].unconfirmed_balance),
            total: parseFloat(this._addressesBalance[address].confirmed_balance) + parseFloat(this._addressesBalance[address].unconfirmed_balance),
        }));
    }

    private handleSocketEvents() {
        this.socketService.socket.on('newBlock', (blockHeight) => {
            console.log(`New Block: ${blockHeight}`);
            if (this.selectedAddress) {
                this.updateLtcBalanceForAddress(this.selectedAddress);
                this.updateTokensBalanceForAddress(this.selectedAddress);
            }
        })
    }

    async updateLtcBalanceForAddress(address: string) {
        this._addressesBalance[address] = {};
        const balanceRes: any = await this.soChainApi.getAddressBalance(address).toPromise();
        if (!balanceRes.data || balanceRes.status !== 'success') return;
        const { unconfirmed_balance, confirmed_balance } = balanceRes.data;
        this._addressesBalance[address] = { unconfirmed_balance, confirmed_balance };
    }

    async updateTokensBalanceForAddress(address: string) {
        if (!address) return;
        this._addressesTokensBalance[address] = {};
        const balanceRes: any = await this.rpcServic.rpc('tl_getallbalancesforaddress', [address]);
        if (!balanceRes.data || balanceRes.error) return;
        this._addressesTokensBalance[address] = balanceRes.data
            .map((d: any) => ({
                propertyid: d.propertyid,
                balance: parseFloat(d.balance),
                reserve: parseFloat(d.reserve),
            }));
    }
}
