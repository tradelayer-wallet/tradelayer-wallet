import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  templateUrl: './offline-wallet.component.html',
  styleUrls: ['./offline-wallet.component.scss'],
})

export class OfflineWalletDialog {
  public message2: string = ' ';

  constructor(
    public dialogRef: MatDialogRef<OfflineWalletDialog>,
    @Inject(MAT_DIALOG_DATA) private data: any,
    private rpcService: RpcService,
    private loadingService: LoadingService,
    private router: Router,
  ) {}

  async startOfflineWallet() {
    this.message2 = ' ';
    this.loadingService.isLoading = true;
    const { directory, isTestNet, flags } = this.data;
    const res = await this.rpcService.startWalletNode(directory, isTestNet, flags, true);
    if (res.error || !res.data) {
      if (!res.error?.includes("Config file doesn't exist in")) {
        this.message2 = res.error || 'Please Try Again!';
      }
      this.loadingService.isLoading = false;
      return;
    }
    this.dialogRef.close();
    this.router.navigateByUrl('/');
    this.loadingService.isLoading = false;
  }

  close() {
    this.dialogRef.close();
  }
}
