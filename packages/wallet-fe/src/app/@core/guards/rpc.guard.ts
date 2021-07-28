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

    async canActivate(): Promise<boolean> {
        const isConnected = this.rpcService.isConnected;
        if (isConnected) return this.rpcService.isConnected;
    
        const ls = await this._checkLocalStorage();
        if (ls) return true;

        this.dialogService.openDialog(DialogTypes.RPC_CONNECT);
        return false;
   }
   
    private async _checkLocalStorage() {
        const cred = window.localStorage.getItem('nodeConnection');
        if (!cred) return false;

        try {
            const credentials = JSON.parse(cred)
            const isConnected = await this.rpcService.connect(credentials);
            return !!isConnected;
        } catch (error) {
            return false
        }
    }
}