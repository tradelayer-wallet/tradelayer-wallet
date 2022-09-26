import { HttpClient } from '@angular/common/http';
import { Component } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { ENetwork, RpcService } from 'src/app/@core/services/rpc.service';
// import { WindowsService } from 'src/app/@core/services/windows.service';
import { environment } from 'src/environments/environment';

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
    // private windowsService: WindowsService,
    private toastrService: ToastrService,
    private http: HttpClient,
    private loadingService: LoadingService,
  ) {}

  async selectNetwork() {
    try {
      this.loadingService.isLoading = true;
      const url = environment.ENDPOINTS[this.network].relayerUrl;
      const checkRes: any = await this.http.post(url + '/rpc/' + 'tl_getinfo', {}).toPromise()
        .catch(() => {
          throw new Error("Error with Connection to API Server");
        });
      if (!checkRes.data?.['tradelayer_version_int'] || checkRes.error) {
        throw new Error("Error with API Server");
      }
      this.rpcService.NETWORK = this.network;
      this.rpcService.isNetworkSelected = true;
      this.dialogRef.close();
      this.router.navigateByUrl('/');
      this.loadingService.isLoading = false;
      // const tab = this.windowsService.tabs.find(t => t.title === "Synchronization");
      // if (tab) tab.minimized = false;
    } catch (error: any) {
      this.toastrService.error(error.message, 'Error');
      this.loadingService.isLoading = false;
    }
  }
}
