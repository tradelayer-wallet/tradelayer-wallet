import { Injectable } from "@angular/core";
import { RpcService } from "./rpc.service";

export interface IKeyPair {
    address: string;
    pubKey: string;
    privKey: string;
}

@Injectable({
    providedIn: 'root',
})

export class AddressService {
    private _keyPairs: IKeyPair[] = [];
    private _activeKeyPair: IKeyPair | null = null;
    constructor(
        private rpcService: RpcService,
    ) {}
    
    get keyPairs() {
        return this._keyPairs;
    }

    set keyPairs(value: IKeyPair[]) {
        this._keyPairs = value
    }

    get activeKeyPair() {
        return this._activeKeyPair;
    }

    set activeKeyPair(value: IKeyPair | null) {
        this._activeKeyPair = value;
    }

    addDecryptedKeyPair(pair: IKeyPair) {
        this.keyPairs = [...this.keyPairs, pair];
        this.activeKeyPair = pair;
    }

    removeAllKeyPairs() {
        this.keyPairs = [];
        this.activeKeyPair = null;
    }

    async generateNewKeyPair() {
        const gnaRes = await this.rpcService.rpc('getnewaddress');
        if (gnaRes.error || !gnaRes.data) return null;
        const address = gnaRes.data;

        const dpkRes = await this.rpcService.rpc('dumpprivkey', [address]);
        if (dpkRes.error || !dpkRes.data) return null;
        const privKey = dpkRes.data;

        const vaRes = await this.rpcService.rpc('validateaddress', [address]);
        if (vaRes.error || !vaRes.data?.pubkey) return null;
        const pubKey = vaRes.data.pubkey;

        const keyPair: IKeyPair = { address, privKey, pubKey}
        return keyPair;
    }
}
