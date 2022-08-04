import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { ApiService } from "./api.service";
import { SocketService } from "./socket.service";
import { DialogService } from "./dialogs.service";
import { LoadingService } from "./loading.service";

export type TNETWORK = 'LTC' | 'LTCTEST' | null;
export enum ENetwork {
  LTC = 'LTC',
  LTCTEST = 'LTCTEST',
};

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

    constructor(
      private apiService: ApiService,
      private socketService: SocketService,
      private dialogService: DialogService,
      private toastrService: ToastrService,
      private loadingService: LoadingService,
    ) {
      this.subsToEvents();
    }

    private subsToEvents() {
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
        console.log(`New Node Block: ${lastBlock}`)
        this.lastBlock = lastBlock;
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
    }

    async createNewNode(params: { username: string, password: string, port: number, path: string }) {
      return await this.mainApi.createNewConfFile(params).toPromise();
    }

    private async checkNetworkInfo() {
      if (!this.NETWORK) return;
      try {
          const infoRes = await this.tlApi.rpc('tl_getinfo').toPromise();
          if (infoRes.error || !infoRes.data) throw new Error(infoRes.error);
          if (infoRes.data.block !== this.networkBlocks) {
            this.networkBlocks = infoRes.data.block;
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
      // this.networkBlocks = 0;
    }
  }