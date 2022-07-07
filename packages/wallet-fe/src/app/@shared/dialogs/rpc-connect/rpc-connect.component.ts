import { Component, NgZone, OnInit } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { ElectronService } from 'src/app/@core/services/electron.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { ENetwork, RpcService } from 'src/app/@core/services/rpc.service';
import { SocketService } from 'src/app/@core/services/socket.service';

@Component({
  selector: 'rpc-connect-dialog',
  templateUrl: './rpc-connect.component.html',
  styleUrls: ['./rpc-connect.component.scss']
})

export class RPCConnectDialog implements OnInit {
  public _defaultDirectoryCheckbox: boolean = true;
  public directory: string = '';

  public reindex: boolean = false;
  public startclean: boolean = false;
  public showAdvanced: boolean = false;
  public network: ENetwork = ENetwork.LTC;
  public message: string = "";
  public startOnProcess: boolean = false;
  constructor(
    private rpcService: RpcService,
    public dialogRef: MatDialogRef<RPCConnectDialog>,
    private electronService: ElectronService,
    private zone: NgZone,
    private router: Router,
    private toastrService: ToastrService,
    private socketService: SocketService,
    private loadingService: LoadingService,
    private dialogService: DialogService,
  ) {}

  get loading() {
    return this.loadingService.isLoading;
  }

  set loading(value: boolean) {
    this.loadingService.isLoading = value
  }

  get defaultDirectoryCheckbox() {
    return this._defaultDirectoryCheckbox;
  }

  set defaultDirectoryCheckbox(value: boolean) {
    this.directory = '';
    this._defaultDirectoryCheckbox = value;
  }

  get socket() {
    return this.socketService.socket;
  }

  ngOnInit(): void {
    this.loadingService.isLoading = false;
    this.socket.on('core-starting-error', (data) => {
      if (data.error) this.message = data.error;
    });
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

  async startWalletNode() {
    this.startOnProcess = true;
    const network = this.network;
    const path = this.defaultDirectoryCheckbox ? '' : this.directory;
    const { reindex, startclean } = this;
    const flags = { reindex, startclean };

    await this.rpcService.startWalletNode(path, network, flags)
      .then(res => {
        if (res.error || !res.data) {
          const configError = res.error.includes("Config file") && res.error.includes("doesn't exist in");
          if (configError) {
            this.dialogService.openDialog(DialogTypes.NEW_NODE, { data: { path }});
          } else {
            this.toastrService.error(res.error || 'Undefined Error', 'Starting Node Error');
          }
        } else {
          this.router.navigateByUrl('/');
        }
      })
      .catch(error => {
        this.toastrService.error(error.message || 'Undefined Error', 'Error request');
      })
      .finally(() => {
        this.message = "";
        this.startOnProcess = false;
      });
  }
}
