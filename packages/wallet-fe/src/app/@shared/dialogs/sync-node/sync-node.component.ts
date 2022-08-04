import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { ApiService } from 'src/app/@core/services/api.service';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { ElectronService } from 'src/app/@core/services/electron.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { ENetwork, RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'sync-node-dialog',
  templateUrl: './sync-node.component.html',
  styleUrls: ['./sync-node.component.scss']
})
export class SyncNodeDialog implements OnInit, OnDestroy {
    readyPercent: number = 0;
    message: string = '';
    eta: string = 'Calculating Remaining Time ...';

    prevEtaData: {
        stamp: number;
        blocks: number;
    } = {
        stamp: 0,
        blocks: 0,
    };

    private checkIntervalFunc: any;

    constructor(
        private rpcService: RpcService,
        private apiService: ApiService,
        private loadingService: LoadingService,
        private electronService: ElectronService,
        private zone: NgZone,
        private dialogService: DialogService,
        private router: Router,
        private toastrService: ToastrService,
    ) {}

    get coreStarted() {
        return this.rpcService.isCoreStarted;
    }

    get isSynced() {
        return this.rpcService.isSynced;
    }

    get nodeBlock() {
        return this.rpcService.lastBlock;
    }

    get networkBlocks() {
        return this.rpcService.networkBlocks;
    }

    get isAbleToRpc() {
        return this.rpcService.isAbleToRpc;
    }

    ngOnInit() { }

    private checFunction() {
        this.checkSync();
        this.checkIntervalFunc = setInterval(() => this.checkSync(), 2000);
    }

    private countETA(etaData: { stamp: number; blocks: number; }) {
        const prevStamp = this.prevEtaData.stamp;
        const prevBlocks = this.prevEtaData.blocks;
        const currentStamp = etaData.stamp;
        const currentBlocks = etaData.blocks;
        this.prevEtaData = etaData;
        if (!prevBlocks || !prevStamp || !currentStamp || !currentBlocks) return;
        const blocksInterval = currentBlocks - prevBlocks;
        const stampInterval = currentStamp - prevStamp;
        const msPerBlock = Math.round(stampInterval / blocksInterval);
        const remainingBlocks = this.networkBlocks - currentBlocks;
        const remainingms = msPerBlock * remainingBlocks;
        const minutes = Math.floor((remainingms / (1000 * 60)) % 60);
        const hours = Math.floor((remainingms / (1000 * 60 * 60)));
        if (remainingms > 0 && remainingms < 604800000 ) {
            const message =  hours > 0 ? `${hours} hours ${minutes} minutes` : `${minutes} minutes`;
            this.eta = `Remaining ~ ${message}`;
        } else {
            this.eta = 'Calculating Remaining Time ...';
        }
    }

    private async checkSync() {
        await this.checkIsAbleToRpc();
        this.countETA({ stamp: Date.now(), blocks: this.nodeBlock });
        this.readyPercent = parseFloat((this.nodeBlock / this.networkBlocks).toFixed(2)) * 100;
    }

    private async checkIsAbleToRpc() {
        if (this.rpcService.isAbleToRpc || !this.rpcService.isCoreStarted) return;
        await this.apiService.mainApi.rpcCall('tl_getinfo').toPromise()
            .then(res => {
                if (res.error) this.message = res.error;
                if (!res.error && res.data) {
                    this.rpcService.isAbleToRpc = true;
                    this.message = '';
                }
            })
            .catch(error => {
                const errrorMessage = error?.message || error || "Undefined Error";
                this.message = errrorMessage;
            });
    }

    async terminate() {
        if (!this.isAbleToRpc) return;
        this.loadingService.isLoading = true;
        const terminateRes = await this.rpcService.terminateNode();
        clearInterval(this.checkIntervalFunc);
        this.message = ' ';
    }

    ngOnDestroy() {
        clearInterval(this.checkIntervalFunc);
    }

    // ------
    public _defaultDirectoryCheckbox: boolean = true;
    public directory: string = '';
    public reindex: boolean = false;
    public startclean: boolean = false;
    public showAdvanced: boolean = false;
    public network: ENetwork = this.rpcService.NETWORK as ENetwork;

    get defaultDirectoryCheckbox() {
        return this._defaultDirectoryCheckbox;
    }

    set defaultDirectoryCheckbox(value: boolean) {
        this.directory = '';
        this._defaultDirectoryCheckbox = value;
    }

    openDirSelectDialog() {
        this.electronService.emitEvent('open-dir-dialog');
        this.electronService.ipcRenderer.once('angular-electron-message', (_: any, message: any) => {
            const { event, data } = message;
            if (event !== 'selected-dir' || !data ) return;
            this.zone.run(() => this.directory = data || '');
        });
    }

    toggleAdvanced() {
        this.showAdvanced = !this.showAdvanced;
        if (!this.showAdvanced) {
        this.reindex = false;
        this.startclean = false;
        }    
    }

    async startWalletNode() {
        const network = this.network;
        if (!network) return;
        const path = this.defaultDirectoryCheckbox ? '' : this.directory;
        const { reindex, startclean } = this;
        const flags = { reindex, startclean };
        this.loadingService.isLoading = true;
        await this.rpcService.startWalletNode(path, ENetwork[network], flags)
        .then(async res => {
            if (res.error || !res.data) {
            const configError = res.error.includes("Config file") && res.error.includes("doesn't exist in");
            if (configError) {
                this.dialogService.openDialog(DialogTypes.NEW_NODE, { data: { path }});
            } else {
                this.toastrService.error(res.error || 'Undefined Error', 'Starting Node Error');
            }
            } else {
                this.router.navigateByUrl('/');
                await this.checkIsAbleToRpc();
            }
        })
        .catch(error => {
            this.toastrService.error(error.message || 'Undefined Error', 'Error request');
        })
        .finally(() => {
            this.checFunction();
            this.loadingService.isLoading = false;
        });
    }
}
