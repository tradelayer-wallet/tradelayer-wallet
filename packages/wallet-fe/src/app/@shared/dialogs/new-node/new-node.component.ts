import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';

const defaultPath = ``;

@Component({
  selector: 'new-node-dialog',
  templateUrl: './new-node.component.html',
  styleUrls: ['./new-node.component.scss']
})
export class NewNodeDialog {
  public loading: boolean = false;
  public message: string = ' ';

  public port: number = 9332;
  public username: string = '';
  public password: string = '';
  public repassword: string = '';

  constructor(
    private loadingService: LoadingService,
    private rpcService: RpcService,
    private toastrService: ToastrService,
    public dialogRef: MatDialogRef<NewNodeDialog>,
    @Inject(MAT_DIALOG_DATA) private data: { directory: string; isTestNet: boolean; flags: any },
  ) { }

  get buttonDisabled() {
      return !this.validCreds();
  }

  get directory() {
    return this.data.directory;
  }

  get isTestNet() {
    return this.data.isTestNet;
  }

  get flags() {
    return this.data.flags;
  }

  async create() {
    this.message = ' ';
    this.loadingService.isLoading = true;
    const validCreds = this.validCreds();
    if (!validCreds) return;
    const { port, username, password } = this;
    const path = this.directory;
    const creds = { port, username, password, path };
    const res = await this.rpcService.createNewNode(creds);

    if (res.error || !res.data) {
      this.message = res.error || 'Please check the inputs and try again!';
      this.loadingService.isLoading = false;
      return;
    } else {
      await this.rpcService.startWalletNode(this.directory, this.isTestNet, this.flags);
      this.loadingService.isLoading = false;
      this.dialogRef.close();
      return;
    }
  }

  validCreds() {
      if (this.port > 65535) return false;
      if (this.username.length < 3) return false;
      if (this.password.length < 3 || this.password !== this.repassword) return false;
      return true;
  }
}
