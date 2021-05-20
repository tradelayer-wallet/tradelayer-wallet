import { Injectable } from "@angular/core";
import { HttpClient, } from "@angular/common/http";

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

    constructor(
      private http: HttpClient,
    ) {}

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
        setTimeout(() => {
          const isReady = this.call(credentials);
          res(isReady)
        }, 2000)
      })
    }

    call(credentials: RPCCredentials) {
      const options = JSON.stringify({
        id: 0,
        method: "help",
        params: []
      });

      this.http.post(
        'http://localhost:9332',
        options,
        {
          headers: {
            'Authorization': 'Basic dXNlcjpwYXNzd3JvZA==',

          }
        }
      ).subscribe(e => console.log(e));
      return false
    }
  }