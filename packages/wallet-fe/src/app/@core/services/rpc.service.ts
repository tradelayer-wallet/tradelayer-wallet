import { Injectable, Injector } from "@angular/core";
import { HttpClient, HttpHeaders } from "@angular/common/http";
import { ApiService } from "./api.service";
import { SocketService } from "./socket.service";
import { ActivatedRoute, Router, RouterStateSnapshot } from "@angular/router";
import { DialogService, DialogTypes } from "./dialogs.service";

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
    private _isSynced: boolean = false;

    private rpcHost: string = '';
    private authToken: string = '';
  
    constructor(
      private http: HttpClient,
      private apiService: ApiService,
      private socketService: SocketService,
      private dialogService: DialogService,
    ) {
      this.socket.on("rpc-connection-error", () => {
        if (this.isConnected) {
          this.clearRPC();
      }
      });
    }



    get isConnected() {
        return this._isConnected;
    }

    set isConnected(value: boolean) {
        this._isConnected = value;
    }

    get isSynced() {
      return this._isSynced;
    }

    set isSynced(value: boolean) {
      this._isSynced = value;
    }

    get socket() {
      return this.socketService.socket;
    }

    connect(credentials: RPCCredentials) {
      return new Promise(async (res, rej) => {
        try {
          const isReady = await this._sendCredsToHomeApi(credentials);
          if (isReady) {
            this._saveCreds(credentials);
          }
          res(isReady);
        } catch (error) {
          rej(error);
        }
      })
    }

    private _sendCredsToHomeApi(credentials: RPCCredentials) {
      return this.apiService.socketScriptApi.connect(credentials).toPromise();
    }

    async startWalletNode(directory: string) {
      const res = await this.apiService.socketScriptApi.startWalletNode(directory).toPromise();
      if (res.error || !res.data) return { error: res.error };
      const host = 'localhost';
      const { rpcuser, rpcpassword, rpcport } = res.data;
      const connectCreds = { host, username: rpcuser, password: rpcpassword, port: rpcport };
      const connectRes = await this.connect(connectCreds);
      if (!connectRes) return { error: 'Error With Node Connection' };
      return { data: connectRes };
    }

    async createNewNode(creds: { username: string, password: string, port: number, path: string }) {
      const res = await this.apiService.socketScriptApi.createNewNode(creds).toPromise();
      return res;
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

    clearRPC() {
      this.isConnected = false;
      this.isSynced = false;
      this.rpcHost = '';
      this.authToken = '';
      this.dialogService.closeAllDialogs();
      this.dialogService.openDialog(DialogTypes.RPC_CONNECT);
    }

    private _saveCreds(credentials: RPCCredentials) {
      // window.localStorage.setItem('nodeConnection', JSON.stringify(credentials));
      this.isConnected = true;
      const url = `http://${credentials.host}:${credentials.port}`;
      this.rpcHost = url;
      this.authToken = window.btoa(`${credentials.username}:${credentials.password}`);
    }
  
    private _getHeaders(token: string) {
      return new HttpHeaders().set('Authorization', `Basic ${token}`);
    }
  }