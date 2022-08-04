import { Component } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { ENetwork, RpcService } from 'src/app/@core/services/rpc.service';
import { WindowsService } from 'src/app/@core/services/windows.service';

@Component({
  selector: 'select-network-dialog',
  templateUrl: './select-network.component.html',
  styleUrls: ['./select-network.component.scss']
})

export class SelectNetworkDialog {
  public network: ENetwork = ENetwork.LTC;

  constructor(
    private rpcService: RpcService,
    public dialogRef: MatDialogRef<SelectNetworkDialog>,
    private router: Router,
    private windowsService: WindowsService,
  ) {}

  async selectNetwork() {
    this.rpcService.NETWORK = this.network;
    this.rpcService.isNetworkSelected = true;
    this.dialogRef.close();
    this.router.navigateByUrl('/');
    // const tab = this.windowsService.tabs.find(t => t.title === "Synchronization");
    // if (tab) tab.minimized = false;
  }
}
