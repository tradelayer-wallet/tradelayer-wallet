import { Component, OnDestroy, OnInit } from '@angular/core';
import { ApiService } from 'src/app/@core/services/api.service';
// import { ApiService } from 'src/app/@core/services/api.service';
import { DialogService } from 'src/app/@core/services/dialogs.service';
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
    networkBlocks: number = 0;
    message: string = '';
    eta: string = 'Calculating Remaining Time ...';

    prevEtaData: {
        stamp: number;
        blocks: number;
    } = {
        stamp: 0,
        blocks: 0,
    };

    private stopChecking: boolean = false;
    private checkIntervalFunc: any;
    private checkTimeOutFunc: any;

    constructor(
        private rpcService: RpcService,
        private apiService: ApiService,
        private socketService: SocketService,
        // private authService: AuthService,
        // private dialogService: DialogService,
        private windowsService: WindowsService,
    ) {}

    get nodeBlock() {
        return this.rpcService.lastBlock;
    }

    // get sochainApi() {
    //     return this.apiService.soChainApi;
    // }

    get coreStarted() {
        return this.rpcService.isCoreStarted;
    }

    get mainApi() {
        return this.apiService.mainApi;
    }

    get isSynced() {
        return this.rpcService.isSynced;
    }

    // get isOffline() {
    //     return this.rpcService.isOffline;
    // }

    get syncTab() {
        return this.windowsService.tabs.find(e => e.title === 'Synchronization');
    }

    get socket() {
        return this.socketService.socket;
    }

    ngOnInit() {
        this.startCheckingSync();
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

    private async startCheckingSync() {
        await this.checkNetworkInfo();
        this.checkIntervalFunc = setInterval(async () => {
            if (!this.coreStarted) return;
            this.checkSync();
        }, 5000);
    }

    private async checkSync() {
        await this.checkNetworkInfo();
        this.countETA({ stamp: Date.now(), blocks: this.nodeBlock });
        this.readyPercent = parseFloat((this.nodeBlock / this.networkBlocks).toFixed(2)) * 100;
         if (this.nodeBlock + 2 >= this.networkBlocks) {
            if (!this.rpcService.isSynced) this.rpcService.isSynced = true;
        }
    }

    private async checkNetworkInfo() {
        try {
            // const networkInfo = await this.sochainApi.getNetworkInfo().toPromise();
            // if (networkInfo.status !== 'success' || !networkInfo.data?.blocks) return
            // this.networkBlocks = networkInfo.data.blocks;
            this.networkBlocks = 660000;
        } catch(err) {
            console.log(err);
        }
    }

    async terminate() {
        const stopRes = await this.mainApi.rpcCall('stop').toPromise();
        console.log({ stopRes });
    }

    ngOnDestroy() {
        clearInterval(this.checkIntervalFunc);
    }
}
