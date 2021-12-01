import { Component } from '@angular/core';
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
    ) { }

    get disableSend() {
        return !this.rpcService.isSynced || this.rpcService.isOffline;
    }

    setLoading(loading: boolean) {
        this.loadingService.isLoading = loading;
    }
}
