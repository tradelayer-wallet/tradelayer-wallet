import { Injectable } from "@angular/core";
import { HttpClient, HttpHeaders } from "@angular/common/http";

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
        return { error: err.error?.error?.message || 'Undifined Error' }
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


    getBestBlock = async () => {
      const bestBlockHashResult = await this.getBestBlockHash();
      const bestBlockHashError = bestBlockHashResult.error;
      const bestBlockHashData = bestBlockHashResult.data;
  
      return bestBlockHashError 
          ? bestBlockHashResult 
          : await this.getBlock(bestBlockHashData);
    };
  
    private async getBestBlockHash() {
      return await this.rpc('getbestblockhash');
    }

    private async getBlock(hash: string) {
      return await this.rpc('getblock', [hash]);
    }


    async buildLTCInstantTrade(vins: any[], payload: string, changeAddress: string, price: string, refAddress: string) {
      if (!vins?.length || !payload || !refAddress || !price || !changeAddress) return { error: 'Missing argumetns for building LTC Instant Trade' };

      const sumVinsAmount = vins.map(vin => vin.amount).reduce((a, b) => a + b, 0);
      if (sumVinsAmount < parseFloat(price)) {
        return { error: 'Error with vins' };
      }
      const tl_createrawtx_inputAll = async () => {
          let hex = '';
          for (const vin of vins) {
              const crtxiRes: any = await this.rpc('tl_createrawtx_input', [hex, vin.txid, vin.vout]);
              if (crtxiRes.error || !crtxiRes.data) return { error: 'Error with creating raw tx' };
              hex = crtxiRes.data;
          }
          return { data: hex };
      };
      const crtxiRes: any = await tl_createrawtx_inputAll();
      if (crtxiRes.error || !crtxiRes.data) return { error: 'Error with creating raw tx' };
      const change = (sumVinsAmount - (parseFloat(price) + 0.0005)).toFixed(4);
      const _crtxrRes: any = await this.rpc('tl_createrawtx_reference', [crtxiRes.data, changeAddress, change]);
      if (_crtxrRes.error || !_crtxrRes.data) return { error: _crtxrRes.error || 'Error with adding referance address' };

      const crtxrRes: any = await this.rpc('tl_createrawtx_reference', [_crtxrRes.data, refAddress, price]);
      if (crtxrRes.error || !crtxrRes.data) return { error: crtxrRes.error || 'Error with adding referance address' };

      const crtxoRes: any = await this.rpc('tl_createrawtx_opreturn', [crtxrRes.data, payload]);
      if (crtxoRes.error || !crtxoRes.data) return { error: 'Error with adding payload' };
      return crtxoRes;
    }

    async getUnspentsForFunding(address: string, minAmount: number) {
      const lusRes = await this.rpc('listunspent', [0, 999999999, [address]]);
      if (lusRes.error || !lusRes.data?.length) {
        return lusRes
      } else {
        let res: any[] = [];
        lusRes.data.forEach((u: any) => {
          const amountSum = res.map(r => r.amount).reduce((a, b) => a + b, 0);
          if (amountSum < (minAmount + 0.1)) res.push(u);
        });
        return { data: res.map(u => ({vout: u.vout, txid: u.txid, amount: u.amount})) };
      }
    }

  }