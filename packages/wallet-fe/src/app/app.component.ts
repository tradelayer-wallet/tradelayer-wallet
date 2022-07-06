import { Component, NgZone } from '@angular/core';
import { ConnectionService } from './@core/services/connections.service';
import { ElectronService } from './@core/services/electron.service';
import { LoadingService } from './@core/services/loading.service';
import { RpcService } from './@core/services/rpc.service';
import { WindowsService } from './@core/services/windows.service';

@Component({
  selector: 'tl-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent {
  private isOnline: boolean = this.connectionService.isOnline;
  constructor(
    private rpcService: RpcService,
    private connectionService: ConnectionService,
    private ngZone: NgZone,
    private loadingService: LoadingService,
    private electronService: ElectronService,
    private windowsService: WindowsService,
  ) {
    this.handleConnections();
    this.handleElectronEvents();
  }

  get windows() {
    return this.windowsService.tabs;
  }

  get isLoading() {
    return this.loadingService.isLoading;
  }

  set isLoading(value: boolean) {
    this.loadingService.isLoading = value;
  }

  get isCoreStarted() {
    return this.rpcService.isCoreStarted;
  }

  handleConnections() {
    this.connectionService.isOnline$
      .subscribe((isOnline) => {
        this.ngZone.run(() => this.isOnline = isOnline);
      })
  }

  handleElectronEvents() {
    this.electronService.ipcRenderer
      .on('angular-electron-message', (_: any, message: any) => {
        const { event, data } = message;
        if (event === 'close-app' && data === true) {
          this.ngZone.run(() =>this.isLoading = true);
        }
      });
  }

  get allConnected() {
    return this.isOnline && this.connectionService.isMainSocketConnected;
  }
}
