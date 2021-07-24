import { Component, Input } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RPCCredentials, RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'rpc-connect-dialog',
  templateUrl: './rpc-connect.component.html',
  styleUrls: ['./rpc-connect.component.scss']
})
export class RPCConnectDialog {
  public loading: boolean = false;
  public message: string = ' ';

  public host: string = 'localhost';
  public port: number = 9332;
  public username: string = '';
  public password: string = '';

  constructor(
    private rpcService: RpcService,
    public dialogRef: MatDialogRef<RPCConnectDialog>,
    private loadingService: LoadingService,
  ) {}

  async connect() {
    this.message = ' ';
    this.loadingService.isLoading = true;

    const { host, port, username, password } = this;
    const credentials: RPCCredentials = { host, port, username, password };
    const isConnected = await this.rpcService.connect(credentials);
    this.loadingService.isLoading = false;
    if (!isConnected) {
      this.message = 'Please try again! ';
    } else {
      this.dialogRef.close();
    }
  }
}
