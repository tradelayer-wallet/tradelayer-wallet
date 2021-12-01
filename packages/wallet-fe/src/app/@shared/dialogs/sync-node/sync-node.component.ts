import { Component, OnDestroy, OnInit } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { ApiService } from 'src/app/@core/services/api.service';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { SocketService } from 'src/app/@core/services/socket.service';
import { AuthService } from 'src/app/@core/services/auth.service';

@Component({
  selector: 'sync-node-dialog',
  templateUrl: './sync-node.component.html',
  styleUrls: ['./sync-node.component.scss']
})
export class SyncNodeDialog implements OnInit, OnDestroy {
    loading: boolean = true;
    readyPercent: number = 0;
    nodeBlock: number = 0;
    networkBlocks: number = 0;
    message: string = ' ';
    terminateDisabled: boolean = true;

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
        private authService: AuthService,
        private dialogService: DialogService,
    ) {}

    get sochainApi() {
        return this.apiService.soChainApi;
    }

    get isSynced() {
        return this.rpcService.isSynced;
    }

    get isOffline() {
        return this.rpcService.isOffline;
    }

    ngOnInit() {
        if (!this.isOffline) this.startCheckingSync();
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
        // this.subscribeToNewBlocks();
        await this.checkNetworkInfo();
        this.checkSync();
        this.checkIntervalFunc = setInterval(() => {
            if (!this.stopChecking) this.checkSync();
        }, 10000);
    }

    private async checkSync() {
        const giRes = await this.rpcService.rpc('tl_getinfo');
        if (giRes.error || !giRes.data) {
            this.terminateDisabled = true;
            this.message = giRes.error || 'Undefined Error!';
            this.stopChecking = true;
            this.checkTimeOutFunc = setTimeout(() => {
                this.checkSync();
            }, 2000);
            return;
        }
        this.terminateDisabled = false;
        this.rpcService.isAbleToRpc = true;
        this.stopChecking = false;
        this.nodeBlock = giRes.data.block;
        await this.checkNetworkInfo();
        this.countETA({ stamp: Date.now(), blocks: this.nodeBlock });
        this.readyPercent = parseFloat((this.nodeBlock / this.networkBlocks).toFixed(2)) * 100;
        if (this.nodeBlock + 1 >= this.networkBlocks && !this.isOffline) {
            this.rpcService.isSynced = true;
            this.message = 'FULL SYNCED';
        }
        this.message = ' ';
        return;
    }

    private async checkNetworkInfo() {
        try {
            if (this.isOffline) return;
            const newtorkInfo = await this.sochainApi.getNetworkInfo().toPromise();
            if (newtorkInfo.status !== 'success' || !newtorkInfo.data?.blocks) return
            this.networkBlocks = newtorkInfo.data.blocks;
        } catch(err) {
            console.log(err);
        }
    }

    private subscribeToNewBlocks() {
        this.socketService.socket.on('newBlock', (b) => (b > 0) ? this.nodeBlock = b : null);
    }

    async terminate() {
        if (this.authService.isLoggedIn) {
            const encKey = this.authService.encKey;
            const dialog = this.dialogService.openEncKeyDialog(encKey);
            await dialog?.afterClosed().toPromise();
            this.authService.logout();
        }
        this.loading = true;
        this.message = " ";
        const stopRes = await this.rpcService.rpc('stop');
        if (stopRes.error || !stopRes.data) {
            this.message = "Error! Please restart the app!";
            return;
        }
        await this.rpcService.clearRPC();
        this.loading = false;

    }

    ngOnDestroy() {
        clearInterval(this.checkIntervalFunc);
        clearTimeout(this.checkTimeOutFunc);
    }
}
