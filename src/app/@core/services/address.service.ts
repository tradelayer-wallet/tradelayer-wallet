import { Injectable } from "@angular/core";

export interface IKeyPair {
    address: string,
    wifKey: string,
}

@Injectable({
    providedIn: 'root',
})

export class AddressService {
    private _keyPairs: IKeyPair[] = [];
    private _activeKeyPair: IKeyPair | null = null;
    constructor() {}
    
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
}
