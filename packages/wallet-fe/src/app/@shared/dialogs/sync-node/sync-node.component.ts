import { TOUCH_BUFFER_MS } from '@angular/cdk/a11y/input-modality/input-modality-detector';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { ApiService } from 'src/app/@core/services/api.service';
// import { ApiService } from 'src/app/@core/services/api.service';
import { DialogService } from 'src/app/@core/services/dialogs.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { SocketService } from 'src/app/@core/services/socket.service';
// import { AuthService } from 'src/app/@core/services/auth.service';
import { WindowsService } from 'src/app/@core/services/windows.service';

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
        private socketService: SocketService,
        private windowsService: WindowsService,
        private loadingService: LoadingService,
    ) {}

    get nodeBlock() {
        return this.rpcService.lastBlock;
    }

    get coreStarted() {
        return this.rpcService.isCoreStarted;
    }

    get mainApi() {
        return this.apiService.mainApi;
    }

    get isSynced() {
        return this.rpcService.isSynced;
    }

    get syncTab() {
        return this.windowsService.tabs.find(e => e.title === 'Synchronization');
    }

    get socket() {
        return this.socketService.socket;
    }

    get networkBlocks() {
        return this.rpcService.networkBlocks;
    }

    get isAbleToRpc() {
        return this.rpcService.isAbleToRpc;
    }

    set isAbleToRpc(value: boolean) {
        this.rpcService.isAbleToRpc = value;
    }

    ngOnInit() {
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
        this.checkIsAbleToRpc();
        this.countETA({ stamp: Date.now(), blocks: this.nodeBlock });
        this.readyPercent = parseFloat((this.nodeBlock / this.networkBlocks).toFixed(2)) * 100;
    }

    private checkIsAbleToRpc() {
        if (this.rpcService.isAbleToRpc || !this.rpcService.isCoreStarted) return;
        this.mainApi.rpcCall('tl_getinfo').toPromise()
            .then(res => {
                if (res.error) this.message = res.error;
                if (!res.error && res.data) {
                    this.isAbleToRpc = true;
                    this.message = '';
                }
            })
            .catch(error => {
                const errrorMessage = error?.message || error || "Undefined Error";
                this.message = errrorMessage;
            });
    }

    async terminate() {
        this.loadingService.isLoading = true;
        await this.rpcService.terminateNode();
    }

    ngOnDestroy() {
        clearInterval(this.checkIntervalFunc);
    }
}
