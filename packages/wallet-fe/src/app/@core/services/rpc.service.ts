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
  header: number;
}

@Injectable({
    providedIn: 'root',
})

export class RpcService {
  private _NETWORK: TNETWORK = null;
  private _stoppedByTerminated: boolean = false;

  isCoreStarted: boolean = false;
  isAbleToRpc: boolean = false;

  isTLStarted: boolean = false;
  latestTlBlock: number = 0;

  lastBlock: number = 0;
  headerBlock: number = 0;
  networkBlocks: number = 0;
  isNetworkSelected: boolean = false;

  blockSubs$: BehaviorSubject<IBlockSubsObj> = new BehaviorSubject({
    type: this.isApiMode ? "API" : "LOCAL",
    block: this.isApiMode ? this.networkBlocks : this.lastBlock,
    header: this.headerBlock,
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

      this.socket.on('new-block', ({ height, header }) => {
        const lastBlock = height;
        this.lastBlock = lastBlock;
        this.headerBlock = header;
        const blockSubsObj: IBlockSubsObj = { type: "LOCAL", block: lastBlock, header };
        this.blockSubs$.next(blockSubsObj);
      });

      setInterval(() => this.checkNetworkInfo(), 8000);
    }

    get isSynced() {
      return this.isAbleToRpc && this.headerBlock && this.lastBlock + 1 >= this.headerBlock && this.latestTlBlock + 1 >= this.headerBlock;
    }

    get NETWORK() {
      return this._NETWORK;
    }

    set NETWORK(value: TNETWORK) {
      this.apiService.network = value;
      this.apiService.apiUrl = null;
      this.apiService.orderbookUrl = null;
      this.headerBlock = 0;
      this._NETWORK = value;
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
      return false;
      // return !this.isCoreStarted || !this.isSynced || !this.lastBlock;
    }

    async startWalletNode(
      path: string,
      network: ENetwork,
      flags: { reindex: boolean, startclean: boolean },
    ) {
      this.NETWORK = network;
      if (this.NETWORK !== network) throw new Error("Please first Change the Network");
      return await this.mainApi
        .startWalletNode(path, network, flags)
        .toPromise()
        .then(res => {
          if (res.data) {
            this.isCoreStarted = true;
            this.dialogService.closeAllDialogs();
          }
          return res;
        });
    }

    async createNewNode(params: { username: string, password: string, port: number, path: string }) {
      return await this.mainApi.createNewConfFile(params).toPromise();
    }

    async checkNetworkInfo() {
      if (!this.NETWORK) return;
      if (!this.apiService.apiUrl) return;
      try {
          const infoRes = await this.tlApi.rpc('getblockchaininfo').toPromise();
          if (infoRes.error || !infoRes.data) throw new Error(infoRes.error);
          if (infoRes.data.block && infoRes.data.block !== this.networkBlocks) {
            this.networkBlocks = infoRes.data.block;
            const blockSubsObj: IBlockSubsObj = { type: "API", block: infoRes.data.block, header: infoRes.data.headers };
            this.blockSubs$.next(blockSubsObj);
            console.log(`New Network Block: ${this.networkBlocks}`);
          }
      } catch(err: any) {
          this.toastrService.error(err.message || err || 'Undefined Error', 'API Server Disconnected');
          this.apiService.apiUrl = null;
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
      return this.mainApi.rpcCall(method, params).toPromise();;
      // return this.isApiMode
      //   ? this.tlApi.rpc(method, params).toPromise()
      //   : this.mainApi.rpcCall(method, params).toPromise();
    }
  }