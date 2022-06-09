import { Injectable } from "@angular/core";
// import { AddressService, IKeyPair } from "./address.service";
import { ApiService } from "./api.service";
import { IKeyPair } from "./auth.service";


@Injectable({
    providedIn: 'root',
})

export class LiquidityProviderService {
    private _isLiquidityStarted: boolean = false;

    constructor(
        // private addressService: AddressService,
        private apiService: ApiService,
    ) {}

    get ssApi() {
        return this.apiService.socketScriptApi;
    }

    get isLiquidityStarted() {
        return this._isLiquidityStarted;
    }

    set isLiquidityStarted(value: boolean) {
        this._isLiquidityStarted = value;
    }

    get liquidityAddresses(): IKeyPair[] {
        return []
    }

    async startLiquidityProviding(options: any) {
        const res = await this.ssApi.startLiquidityScript(options).toPromise();
        if (res.data === true) this.isLiquidityStarted = true;
    }

    async stopLiquidityProviding(address: string) {
        const res = await this.ssApi.stopLiquidityScript(address).toPromise();
        if (res.data === true) this.isLiquidityStarted = false;
    }
}
