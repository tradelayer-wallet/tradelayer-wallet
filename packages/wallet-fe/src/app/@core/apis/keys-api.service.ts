import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { environment } from "src/environments/environment";
import { IWalletObj } from "../services/auth.service";
import { TNETWORK } from "../services/rpc.service";

@Injectable({
    providedIn: 'root',
})

export class KeysApiService {
    private NETWORK: TNETWORK = null;

    constructor(
        private http: HttpClient,
    ) {}

    _setNETWORK(value: TNETWORK) {
        this.NETWORK = value;
    }

    private get apiUrl() {
        return environment.homeApiUrl + '/keys/'
    }

    getNewWallet() {
        const network = this.NETWORK;
        if (!network) throw new Error("No Network Found");
        return this.http.post(this.apiUrl + 'new-wallet', { network });
    }

    getKeyPair(derivatePath: string, mnemonic: string) {
        const network = this.NETWORK;
        if (!network) throw new Error("No Network Found");
        return this.http.post(this.apiUrl + 'get-address', { network, mnemonic, derivatePath });
    }

    getKeyPairsFromLoginFile(walletObjRaw: IWalletObj, mnemonic: string) {
        const network = this.NETWORK;
        if (!network) throw new Error("No Network Found");
        return this.http.post(this.apiUrl + 'get-address-file', { network, mnemonic, walletObjRaw });
    }
}
