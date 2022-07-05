import { Injectable } from '@angular/core';
import { CanActivate } from '@angular/router';
import { DialogService, DialogTypes } from '../services/dialogs.service';
import { RpcService } from '../services/rpc.service';
import { SocketService } from '../services/socket.service';

@Injectable({
    providedIn: 'root',
})

export class RPCGuard implements CanActivate {
    constructor(
        private rpcService: RpcService,
        private dialogService: DialogService,
        // private socketService: SocketService,
    ) {}

    async canActivate(): Promise<boolean> {
        const isConnected = this.rpcService.isCoreStarted;
        // newVersion Dialog switch to rpc Connect dialog after closing
        if (!isConnected) this.dialogService.openDialog(DialogTypes.NEW_VERSION);
        return isConnected;
   }
}