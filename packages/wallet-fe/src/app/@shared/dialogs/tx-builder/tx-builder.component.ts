import { Component } from '@angular/core';
import { AuthService } from 'src/app/@core/services/auth.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'tx-builder-dialog',
  templateUrl: './tx-builder.component.html',
  styleUrls: ['./tx-builder.component.scss']
})

export class TxBuilderDialog {
    constructor(
        private loadingService: LoadingService,
        private rpcService: RpcService,
        private authService: AuthService,
    ) { }

    get disableSend() {
        return !this.rpcService.isSynced || this.rpcService.isOffline;
    }

    get disableSign() {
        return !this.authService.isLoggedIn;
    }

    setLoading(loading: boolean) {
        this.loadingService.isLoading = loading;
    }
}
