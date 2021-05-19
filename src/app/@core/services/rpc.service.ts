import { Injectable } from "@angular/core";

export interface RPCCredentials {
  host: string,
  port: number,
  username: string,
  password: string,
};

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

    connect(credentials: RPCCredentials) {
      console.log('connecting');
      console.log(credentials)
      return new Promise((res, rej) => {
        setTimeout(() => res(false), 3000);
      })
    }
  }