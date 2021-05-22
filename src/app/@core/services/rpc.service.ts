import { Injectable } from "@angular/core";
import { HttpClient, HttpHeaders, } from "@angular/common/http";
import { catchError } from 'rxjs/operators'
import { of } from "rxjs";
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

    private rpcHost: string = '';
    private authToken: string = '';

    constructor(
      private http: HttpClient,
    ) {}

    get isConnected() {
        return this._isConnected;
    }

    set isConnected(value: boolean) {
        this._isConnected = value;
    }

    connect(credentials: RPCCredentials) {
      return new Promise(async (res, rej) => {
        try {
          const isReady = await this._checkConnection(credentials);
          if (isReady) this._setConnection(credentials);
          res(isReady);
        } catch (error) {
          rej(error);
        }
      })
    }

    private async _checkConnection(credentials: RPCCredentials) {
      const result = await this.rpc('tl_getinfo', [], credentials);
      const { error, data } = result;
      if (!error && data?.block > 0) return true;
      return false;
    }

    async rpc(method: string, params: any[] = [], credentials?: RPCCredentials) {
      try {
        const url = credentials ? `http://${credentials.host}:${credentials.port}` : this.rpcHost;
        const authToken = credentials ? window.btoa(`${credentials.username}:${credentials.password}`) : this.authToken;
        const id = Date.now();
        const body = { id, method, params };
        const headers = this._getHeaders(authToken);
        const methodRes = await this.http.post(url, JSON.stringify(body), { headers })
          .toPromise() as { error: any, result: any };
        const { error, result } = methodRes;
        if (error || !result) return { error: error.message || 'Error with RPC call' };
        return { data: result };
      } catch (err) {
        return { error: err.message }
      }
    }

    private _setConnection(credentials: RPCCredentials) {
      window.localStorage.setItem('nodeConnection', JSON.stringify(credentials));
      this.isConnected = true;
      const url = `http://${credentials.host}:${credentials.port}`;
      this.rpcHost = url;
      this.authToken = window.btoa(`${credentials.username}:${credentials.password}`);
    }

    private _getHeaders(token: string) {
      return new HttpHeaders().set('Authorization', `Basic ${token}`);
    }

  }