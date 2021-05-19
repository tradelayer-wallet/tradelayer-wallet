import { Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { DialogService, DialogTypes } from '../services/dialogs.service';
import { RpcService } from '../services/rpc.service';

@Injectable({
    providedIn: 'root',
})

export class RPCGuard implements CanActivate {
    constructor(
        private rpcService: RpcService,
        private dialogService: DialogService,
    ) {}

    canActivate(): boolean {
        const isConnected = this.rpcService.isConnected;
        if (!isConnected) {
            this.dialogService.openDialog(DialogTypes.RPC_CONNECT);
            return false;
        } else {
            return this.rpcService.isConnected
        }
   }
   
}