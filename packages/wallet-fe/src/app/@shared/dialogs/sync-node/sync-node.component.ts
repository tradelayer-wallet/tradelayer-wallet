import { Component, OnDestroy, OnInit } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { ApiService } from 'src/app/@core/services/api.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { SocketService } from 'src/app/@core/services/socket.service';

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

    private stopChecking: boolean = false;
    private checkIntervalFunc: any;

    constructor(
        public dialogRef: MatDialogRef<SyncNodeDialog>,
        private rpcService: RpcService,
        private apiService: ApiService,
        private socketService: SocketService,
        private router: Router,
    ) {}

    get sochainApi() {
        return this.apiService.soChainApi;
    }

    ngOnInit() {
        this.startCheckingSync();
    }

    private startCheckingSync() {
        this.subscribeToNewBlocks();
        this.checkSync();
        this.checkIntervalFunc = setInterval(() => !this.stopChecking ? this.checkSync() : null, 30000);
    }

    private async checkSync() {
        const giRes = await this.rpcService.rpc('tl_getinfo');
        if (giRes.error || !giRes.data) {
            this.message = giRes.error || 'Undefined Error!';
            this.stopChecking = true;
            setTimeout(() => this.checkSync(), 2000);
            return;
        }
        this.stopChecking = false;
        this.nodeBlock = giRes.data.block;

        const newtorkInfo = await this.sochainApi.getNetworkInfo().toPromise();
        if (newtorkInfo.status !== 'success' || !newtorkInfo.data?.blocks) return
        this.networkBlocks = newtorkInfo.data.blocks;

        this.readyPercent = parseFloat((this.nodeBlock / this.networkBlocks).toFixed(2)) * 100;

        if ((this.nodeBlock + 3) > this.networkBlocks) {
            this.rpcService.isSynced = true;
            this.dialogRef.close();
            this.router.navigateByUrl('/');
        }

        this.message = ' ';
        return;
    }

    private subscribeToNewBlocks() {
        this.socketService.socket.on('newBlock', (b) => (b > 0) ? this.nodeBlock = b : null);
    }

    async terminate() {
        this.message = " ";
        const stopRes = await this.rpcService.rpc('stop');
        if (stopRes.error || !stopRes.data) {
            this.message = "Error! Please restart the app!";
            return;
        }
        this.rpcService.clearRPC();
        this.dialogRef.close();
        this.router.navigateByUrl('/');
    }

    ngOnDestroy() {
        clearInterval(this.checkIntervalFunc);
    }
}
