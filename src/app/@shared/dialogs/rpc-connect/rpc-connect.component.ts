import { Component, Input } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
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
    public dialogRef: MatDialogRef<RPCConnectDialog>
  ) {}

  async connect() {
    this.message = ' ';
    this.loading = true;

    const { host, port, username, password } = this;
    const credentials: RPCCredentials = { host, port, username, password };
    const isConnected = await this.rpcService.connect(credentials);
    this.loading = false;
    if (!isConnected) {
      this.message = 'Please try again! ';
    } else {
      this.dialogRef.close();
    }
  }
}
