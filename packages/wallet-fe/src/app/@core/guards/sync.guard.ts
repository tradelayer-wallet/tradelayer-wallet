import { Injectable } from '@angular/core';
import { CanActivate } from '@angular/router';
import { DialogService, DialogTypes } from '../services/dialogs.service';
import { RpcService } from '../services/rpc.service';

@Injectable({
    providedIn: 'root',
})

export class SyncedGuard implements CanActivate {
    constructor(
        private rpcService: RpcService,
        private dialogService: DialogService,
    ) {}

    canActivate(): boolean {
        const isSynced = this.rpcService.isSynced;
        if (isSynced) return this.rpcService.isSynced;

        this.dialogService.openDialog(DialogTypes.SYNC_NODE);
        return false;
   }
}