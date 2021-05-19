import { Injectable } from "@angular/core";

@Injectable({
    providedIn: 'root',
  })

export class RpcService {
    private _isConnected: boolean = false;

    constructor() {}

    get isConnected() {
        return this._isConnected;
    }

    set isConnected(value: boolean) {
        this. isConnected = value;
    }
  }