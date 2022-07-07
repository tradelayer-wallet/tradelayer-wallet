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
  public port: number = 9332;
  public username: string = '';
  public password: string = '';
  public repassword: string = '';

  constructor(
    private loadingService: LoadingService,
    private rpcService: RpcService,
    private toastrService: ToastrService,
    public dialogRef: MatDialogRef<NewNodeDialog>,
    @Inject(MAT_DIALOG_DATA) private data: { path: string },
  ) { }

  get buttonDisabled() {
      return !this.validCreds();
  }

  get path() {
    return this.data.path;
  }

  async create() {
    this.loadingService.isLoading = true;
    const { port, username, password, path } = this;
    const params = { port, username, password, path };
    await this.rpcService.createNewNode(params)
      .then(res => {
        if (res.error || !res.data) {
          const message = res.error || 'Undefined Error. Try again!';
          this.toastrService.error(message, 'Error with Creating Conf File');
        } else {
          this.toastrService.success(res.data, 'Config File Created');
          this.dialogRef.close();
        }
      })
      .catch(err => {
        this.toastrService.error(err.message || 'Undefined Error', 'Error with Creating Conf File');
      })
      .finally(() => {
        this.loadingService.isLoading = false;
      });

  }

  validCreds() {
      if (this.port > 65535) return false;
      if (this.username.length < 3) return false;
      if (this.password.length < 3 || this.password !== this.repassword) return false;
      return true;
  }
}
