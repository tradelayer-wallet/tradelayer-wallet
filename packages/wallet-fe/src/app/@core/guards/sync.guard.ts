import { Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { DialogService, DialogTypes } from '../services/dialogs.service';
import { RpcService } from '../services/rpc.service';

@Injectable({
    providedIn: 'root',
})

export class SyncedGuard implements CanActivate {
    constructor(
        private rpcService: RpcService,
        private toastrService: ToastrService,
        private router: Router,
    ) {}

    canActivate(): boolean {
        const isOffline = this.rpcService.isOffline;
        const isSynced = this.rpcService.isSynced;
        if (isOffline) {
            this.toastrService.warning('Not allowed in offline mode', 'Warning');
            return false;
        }
        if (!isSynced) {
            this.toastrService.warning('Need full sync!', 'Warning');
            return false;
        }
        return true;
   }
}