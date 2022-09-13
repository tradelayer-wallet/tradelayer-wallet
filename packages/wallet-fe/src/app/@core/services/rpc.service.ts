import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { ApiService } from "./api.service";
import { SocketService } from "./socket.service";
import { DialogService } from "./dialogs.service";
import { LoadingService } from "./loading.service";
import { BehaviorSubject } from "rxjs";

export type TNETWORK = 'LTC' | 'LTCTEST' | null;
export enum ENetwork {
  LTC = 'LTC',
  LTCTEST = 'LTCTEST',
};

export interface IBlockSubsObj {
  type: "API" | "LOCAL";
  block: number;
}

@Injectable({
    providedIn: 'root',
})

export class RpcService {
  private _NETWORK: TNETWORK = null;
  private _stoppedByTerminated: boolean = false;

  isCoreStarted: boolean = false;
  isAbleToRpc: boolean = false;
  lastBlock: number = 0;
  networkBlocks: number = 0;
  isNetworkSelected: boolean = false;

  blockSubs$: BehaviorSubject<IBlockSubsObj> = new BehaviorSubject({
    type: this.isApiMode ? "API" : "LOCAL",
    block: this.isApiMode ? this.networkBlocks : this.lastBlock,
  });

    constructor(
      private apiService: ApiService,
      private socketService: SocketService,
      private dialogService: DialogService,
      private toastrService: ToastrService,
      private loadingService: LoadingService,
    ) {}

    onInit() {
      this.socket.on('core-error', error => {
        this.clearRpcConnection();
        if (!this._stoppedByTerminated) {
          this.toastrService.error(error || 'Undefiend Reason', 'Core Stopped Working');
        } else {
          this.toastrService.success(error || 'Core Stopped Successfull');
          this._stoppedByTerminated = false;
          this.loadingService.isLoading = false;
        }
      });

      this.socket.on('new-block', lastBlock => {
        console.log(`New Node Block: ${lastBlock}`);
        this.lastBlock = lastBlock;
        const blockSubsObj: IBlockSubsObj = { type: "LOCAL", block: lastBlock };
        this.blockSubs$.next(blockSubsObj);
      });

      setInterval(() => this.checkNetworkInfo(), 5000);
    }

    get isSynced() {
      return this.lastBlock + 1 >= this.networkBlocks;
    }

    get NETWORK() {
      return this._NETWORK;
    }

    set NETWORK(value: TNETWORK) {
      this.apiService._setNETOWRK(value);
      this._NETWORK = value;
      this.checkNetworkInfo();
    }

    get socket() {
      return this.socketService.socket;
    }

    get mainApi() {
      return this.apiService.mainApi;
    }

    get tlApi() {
      return this.apiService.tlApi;
    }
  
    get isApiMode() {
      return !this.isCoreStarted || !this.isSynced || !this.lastBlock;
    }

    async startWalletNode(
      path: string,
      network: ENetwork,
      flags: { reindex: boolean, startclean: boolean },
    ) {
      this.NETWORK = network;
      await this.tlApi.rpc('tl_getinfo').toPromise()
        .then(res2 => {
          if (res2.error || !res2.data) throw new Error(`${ res2.error || 'Undefined Error' }`);
        })
        .catch(error => {
          throw new Error(`Error with Tradelayer API Server: ${error.message || error || 'Undefined Error'}`);
        });

<<<<<<< HEAD
      return await this.mainApi
        .startWalletNode(path, network, flags)
        .toPromise()
        .then(res => {
          if (res.data) {
            this.isCoreStarted = true;
            this.dialogService.closeAllDialogs();
          }
          return res;
        })
=======
      const isTestNet = network.endsWith('TEST');
      if (res.error?.includes("Config file doesn't exist in")) {
        const dialogOptions = { disableClose: false, hasBackdrop: true, data: { directory, isTestNet, flags }};
        this.dialogService.openDialog(DialogTypes.NEW_NODE, dialogOptions);
        return { error: res.error };
      }

      if (res.error || !res.data?.configObj) return { error: res.error };
      this.socketService.mainApiServerWaiting = true;
      this.isOffline = res.data.isOffline;
      this.myVersion = res.data.myVersion
      const host = 'localhost';
      const { rpcuser, rpcpassword, rpcport } = res.data.configObj;
      const connectCreds = { host, username: rpcuser, password: rpcpassword, port: rpcport };
      const connectRes = await this.connect(connectCreds, network);
      if (!connectRes) return { error: 'Unable to start local node. Probably already running' };
      this.dialogService.closeAllDialogs();
      return { data: connectRes };
>>>>>>> master
    }

    async createNewNode(params: { username: string, password: string, port: number, path: string }) {
      return await this.mainApi.createNewConfFile(params).toPromise();
    }

    private async checkNetworkInfo() {
      if (!this.NETWORK) return;
      try {
          const infoRes = await this.tlApi.rpc('tl_getinfo').toPromise();
          if (infoRes.error || !infoRes.data) throw new Error(infoRes.error);
          if (infoRes.data.block && infoRes.data.block !== this.networkBlocks) {
            this.networkBlocks = infoRes.data.block;
            const blockSubsObj: IBlockSubsObj = { type: "API", block: infoRes.data.block };
            this.blockSubs$.next(blockSubsObj);
            console.log(`New Network Block: ${this.networkBlocks}`);
          }
      } catch(err: any) {
          this.toastrService.error(err.message || err || 'Undefined Error', 'Gettinf Network Block Error');
          throw(err);
      }
    }

    async terminateNode() {
      return await this.mainApi.stopWalletNode().toPromise()
        .then(res => {
          this.clearRpcConnection();
          this._stoppedByTerminated = true;
          return res;
        })
        .catch(err => {
          this.toastrService.error('Error with stopping Node', err?.message || err);
        });
    }

    private clearRpcConnection() {
      this.isAbleToRpc = false;
      this.isCoreStarted = false;
      this.lastBlock = 0;
    }

    rpc(method: string, params?: any[]) {
      return this.isApiMode
        ? this.tlApi.rpc(method, params).toPromise()
        : this.mainApi.rpcCall(method, params).toPromise();
    }
  }