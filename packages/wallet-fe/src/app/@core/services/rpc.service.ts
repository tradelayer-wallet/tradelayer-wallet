import { Injectable } from "@angular/core";
import { HttpClient, HttpHeaders } from "@angular/common/http";
import { ApiService } from "./api.service";
import { SocketService } from "./socket.service";
import { DialogService, DialogTypes } from "./dialogs.service";
import { ToastrService } from "ngx-toastr";
import { WindowsService } from "./windows.service";
import { LoadingService } from "./loading.service";

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
    public isAbleToRpc: boolean = false;
    public isOffline: boolean = false;
    public myVersion: string = 'Unknown';
  
    constructor(
      private http: HttpClient,
      private apiService: ApiService,
      private socketService: SocketService,
      private dialogService: DialogService,
      private toasterService: ToastrService,
      private loadingService: LoadingService,
    ) {
      this.socket.on("rpc-connection-error", (error: string) => {
        if (!this.isConnected) return;
        this.toasterService.error(error || `Undefined Error!`, `RPC Connection Error!.`);
        this.clearRPC();
      });
            
      this.socket.on("local-node-stopped", (error: string) => {
        this.toasterService.error(error || `Undefined Error!`, `Local Node stopped working.`);
        if (this.isConnected) this.clearRPC();
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
      this.apiService.fundingApi.NETWORK = value;
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

    async startWalletNode(directory: string, isTestNet: boolean, flags: { reindex: boolean, startclean: boolean }) {
      const res = await this.socketScriptApi.startWalletNode(directory, isTestNet, flags).toPromise();
      if (res.error?.includes("Config file doesn't exist in")) {
        const dialogOptions = { disableClose: false, hasBackdrop: true, data: { directory, isTestNet, flags }};
        this.dialogService.openDialog(DialogTypes.NEW_NODE, dialogOptions);
        return { error: res.error };
      }

      if (res.error || !res.data?.configObj) return { error: res.error };
      this.isOffline = res.data.isOffline;
      this.myVersion = res.data.myVersion
      const host = 'localhost';
      const { rpcuser, rpcpassword, rpcport } = res.data.configObj;
      const connectCreds = { host, username: rpcuser, password: rpcpassword, port: rpcport };
      const connectRes = await this.connect(connectCreds, isTestNet);
      if (!connectRes) return { error: 'Error With Node Connection' };
      this.dialogService.closeAllDialogs();
      // this.dialogService.openDialog(DialogTypes.SYNC_NODE);
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

    async clearRPC() {
      this.loadingService.isLoading = true;
      if (this.isConnected) await this.socketScriptApi.terminate().toPromise();
      this.isConnected = false;
      this.isSynced = false;
      this.isAbleToRpc = false;
      this.rpcHost = '';
      this.authToken = '';
      this.dialogService.closeAllDialogs();
      this.dialogService.openDialog(DialogTypes.RPC_CONNECT);
      this.NETWORK = 'LTC';
      this.loadingService.isLoading = false;
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