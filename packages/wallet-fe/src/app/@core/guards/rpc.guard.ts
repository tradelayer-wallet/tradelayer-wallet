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
        private socketService: SocketService,
    ) {}

    canActivate(): boolean {
        this.dialogService.closeAllDialogs();
        if (!this.socketService.socket?.connected) return false;

        const isConnected = this.rpcService.isConnected;
        // const isSynced = this.rpcService.isSynced;

        if (!isConnected) {
            this.dialogService.openDialog(DialogTypes.RPC_CONNECT);
            return false;
        }

        // if (isConnected && !isSynced) {
        //     this.dialogService.openDialog(DialogTypes.SYNC_NODE);
        //     return false;
        // }

        // if (isConnected && isSynced) return true;
        if (isConnected) return true;
        return false;
   }
   
    // private async _checkLocalStorage() {
    //     const cred = window.localStorage.getItem('nodeConnection');
    //     if (!cred) return false;

    //     try {
    //         const credentials = JSON.parse(cred)
    //         const isConnected = await this.rpcService.connect(credentials);
    //         return !!isConnected;
    //     } catch (error) {
    //         return false
    //     }
    // }
}