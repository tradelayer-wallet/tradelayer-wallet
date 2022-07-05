import { Component, NgZone } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { ElectronService } from 'src/app/@core/services/electron.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { ENetwork, RpcService } from 'src/app/@core/services/rpc.service';

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
  public _defaultDirectoryCheckbox: boolean = true;
  public directory: string = '';

  public reindex: boolean = false;
  public startclean: boolean = false;
  public showAdvanced: boolean = false;

  public isOnline: boolean = window.navigator.onLine;
  public network: ENetwork = ENetwork.LTC;

  constructor(
    private rpcService: RpcService,
    public dialogRef: MatDialogRef<RPCConnectDialog>,
    private loadingService: LoadingService,
    private electronService: ElectronService,
    private zone: NgZone,
    private router: Router,
  ) {}

  get defaultDirectoryCheckbox() {
    return this._defaultDirectoryCheckbox;
  }

  set defaultDirectoryCheckbox(value: boolean) {
    this.directory = '';
    this._defaultDirectoryCheckbox = value;
  }

  toggleAdvanced() {
    this.showAdvanced = !this.showAdvanced;
    if (!this.showAdvanced) {
      this.reindex = false;
      this.startclean = false;
    }    
  }

  openDirSelectDialog() {
    this.electronService.emitEvent('open-dir-dialog');
    this.electronService.ipcRenderer.once('angular-electron-message', (_: any, message: any) => {
      const { event, data } = message;
      if (event !== 'selected-dir' || !data ) return;
      this.zone.run(() => this.directory = data || '');
    });
  }

  // async connect() {
  //   this.message = ' ';
  //   this.loadingService.isLoading = true;

  //   const { host, port, username, password } = this;
  //   const credentials: RPCCredentials = { host, port, username, password };
  //   const isTestNet = this.isTestNet;
  //   const isConnected = await this.rpcService.connect(credentials, isTestNet);
  //   this.loadingService.isLoading = false;
  //   if (!isConnected) {
  //     this.message = 'Please try again! ';
  //   } else {
  //     this.dialogRef.close();
  //     this.loadingService.isLoading = false;
  //   }
  // }

  async startWalletNode() {
    // this.message2 = ' ';
    // this.loadingService.isLoading = true;
    // // const isTestNet = false;
    const network = this.network;
    const path = this.defaultDirectoryCheckbox ? '' : this.directory;
    const { reindex, startclean } = this;
    const flags = { reindex, startclean };

    console.log({ path, network, flags });
    // const res = await this.rpcService.startWalletNode(path, network, flags, !this.isOnline);
    // if (res.error || !res.data) {
    //   this.message2 = res.error || 'Please Try Again!';
    //   this.loadingService.isLoading = false;
    //   return;
    // }
    // this.dialogRef.close();
    // this.router.navigateByUrl('/');
    // this.loadingService.isLoading = false;
  }
}
