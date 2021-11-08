import { Component, NgZone } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { ElectronService } from 'src/app/@core/services/electron.service';
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
  public message2: string = ' ';

  public host: string = 'localhost';
  public port: number = 9332;
  public username: string = '';
  public password: string = '';
  public defaultDirectoryCheckbox: boolean = true;
  public directory: string = '';
  public isTestNet: boolean = false;

  constructor(
    private rpcService: RpcService,
    public dialogRef: MatDialogRef<RPCConnectDialog>,
    private loadingService: LoadingService,
    private dialogService: DialogService,
    private electronService: ElectronService,
    private zone: NgZone,
  ) {}

  openDirSelectDialog() {
    this.electronService.emitEvent('open-dir-dialog');
    this.electronService.ipcRenderer.once('angular-electron-message', (_: any, message: any) => {
      const { event, data } = message;
      if (event !== 'selected-dir' || !data ) return;
      this.zone.run(() => this.directory = data || '');
    });
  }

  async connect() {
    this.message = ' ';
    this.loadingService.isLoading = true;

    const { host, port, username, password } = this;
    const credentials: RPCCredentials = { host, port, username, password };
    const isTestNet = this.isTestNet;
    const isConnected = await this.rpcService.connect(credentials, isTestNet);
    this.loadingService.isLoading = false;
    if (!isConnected) {
      this.message = 'Please try again! ';
    } else {
      this.dialogRef.close();
      this.dialogService.openDialog(DialogTypes.SYNC_NODE);
      this.loadingService.isLoading = false;
    }
  }

  async startWalletNode() {
    this.message2 = ' ';
    this.loadingService.isLoading = true;
    const isTestNet = this.isTestNet;
    const path = this.defaultDirectoryCheckbox ? '' : this.directory;
    const res = await this.rpcService.startWalletNode(path, isTestNet);
    if (res.error || !res.data) {
      if (!res.error?.includes("Config file doesn't exist in")) {
        this.message2 = res.error || 'Please Try Again!';
      }
      this.loadingService.isLoading = false;
      return;
    }
    this.dialogRef.close();
    this.dialogService.openDialog(DialogTypes.SYNC_NODE);
    this.loadingService.isLoading = false;
  }

  async newNodeConfiguration() {
    this.message2 = ' ';
    const dialogOptions = { disableClose: false, hasBackdrop: true };
    this.dialogService.openDialog(DialogTypes.NEW_NODE, dialogOptions);
  }
}
