import { Component } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { ENetwork, RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'select-network-dialog',
  templateUrl: './select-network.component.html',
  styleUrls: ['./select-network.component.scss']
})

export class SelectNetworkDialog {
  public network: ENetwork = ENetwork.LTCTEST;

  constructor(
    private rpcService: RpcService,
    public dialogRef: MatDialogRef<SelectNetworkDialog>,
    private router: Router,
    private toastrService: ToastrService,
    private loadingService: LoadingService,
  ) {}

  async selectNetwork() {
    try {
      this.loadingService.isLoading = true;
      this.rpcService.NETWORK = this.network;
      this.rpcService.isNetworkSelected = true;
      this.dialogRef.close();
      this.router.navigateByUrl('/');
      this.loadingService.isLoading = false;
    } catch (error: any) {
      this.toastrService.error(error.message, 'Error');
      this.loadingService.isLoading = false;
    }
  }
}
