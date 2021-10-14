import { Injectable } from "@angular/core";
import { HttpClient, HttpHeaders } from "@angular/common/http";
import { ApiService } from "./api.service";
import { SocketService } from "./socket.service";
import { DialogService, DialogTypes } from "./dialogs.service";

export type TNETWORK = 'LTC' | 'LTCTEST';

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
    private _NETWORK: TNETWORK = "LTC";

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

    get NETWORK() {
      return this._NETWORK;
    }

    set NETWORK(value: TNETWORK) {
      this.setNetworkInAllServices(value);
        this._NETWORK = value;
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
      this.saveConfigFile();
      this._isSynced = value;
    }

    get socket() {
      return this.socketService.socket;
    }

    get socketScriptApi() {
      return this.apiService.socketScriptApi;
    }

    private async saveConfigFile() {
      const isTestNet = this.NETWORK === "LTCTEST";
      const res = await this.socketScriptApi.saveConfigFile(isTestNet).toPromise();
    }

    private setNetworkInAllServices(value: TNETWORK) {
      this.apiService.soChainApi.NETWORK = value;
      this.apiService.marketApi.NETWORK = value;
    }

    connect(credentials: RPCCredentials, isTestNet: boolean) {
      return new Promise(async (res, rej) => {
        try {
          const isReady = await this._sendCredsToHomeApi(credentials);
          if (isReady) {
            this._saveCreds(credentials);
            if (isTestNet) this.NETWORK = "LTCTEST";
          }
          res(isReady);
        } catch (error) {
          rej(error);
        }
      })
    }

    private _sendCredsToHomeApi(credentials: RPCCredentials) {
      return this.socketScriptApi.connect(credentials).toPromise();
    }

    async startWalletNode(directory: string, isTestNet: boolean) {
      const res = await this.socketScriptApi.startWalletNode(directory, isTestNet).toPromise();
      if (res.error || !res.data) return { error: res.error };
      const host = 'localhost';
      const { rpcuser, rpcpassword, rpcport } = res.data;
      const connectCreds = { host, username: rpcuser, password: rpcpassword, port: rpcport };
      const connectRes = await this.connect(connectCreds, isTestNet);
      if (!connectRes) return { error: 'Error With Node Connection' };
      return { data: connectRes };
    }

    async createNewNode(creds: { username: string, password: string, port: number, path: string }) {
      const res = await this.socketScriptApi.createNewNode(creds).toPromise();
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
      } catch (err: any) {
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