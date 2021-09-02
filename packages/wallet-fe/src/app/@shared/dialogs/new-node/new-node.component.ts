import { Component } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';

const defaultPath = ` `;

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

  public defaultDirectoryCheckbox: boolean = true;
  public directory: string = defaultPath;

  constructor(
    private loadingService: LoadingService,
    private rpcService: RpcService,
    private dialogService: DialogService,
    public dialogRef: MatDialogRef<NewNodeDialog>,

  ) {}

  get buttonDisabled() {
      return !this.validCreds();
  }

  async create() {
    this.message = ' ';
    this.loadingService.isLoading = true;
    const validCreds = this.validCreds();
    if (!validCreds) return;
    const { port, username, password } = this;
    const path = this.defaultDirectoryCheckbox ? defaultPath : this.directory;
    const creds = { port, username, password, path };
    const res = await this.rpcService.createNewNode(creds);

    if (res.error || !res.data) {
      this.message = res.error || 'Please check the inputs and try again!';
      this.loadingService.isLoading = false;
      return;
    }

    const res2 = await this.rpcService.startWalletNode(path);

    if (res2.error || !res2.data) {
      this.message = res.error || 'Please Try Again!';
    } else {
      this.dialogRef.close();
      this.dialogService.openDialog(DialogTypes.SYNC_NODE)
    }
    this.loadingService.isLoading = false;
    return;
  }

  validCreds() {
      if (this.port > 65535) return false;
      if (this.username.length < 3) return false;
      if (this.password.length < 3 || this.password !== this.repassword) return false;
      if (!this.directory.length) return false;
      return true;
  }
}
