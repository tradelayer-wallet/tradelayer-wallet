import { Component } from '@angular/core';
import { LoadingService } from './@core/services/loading.service';
import { RpcService } from './@core/services/rpc.service';

import { SocketService } from './@core/services/socket.service';
import { WindowsService } from './@core/services/windows.service';

@Component({
  selector: 'tl-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent {
  constructor(
    private socketService: SocketService,
    private loadingService: LoadingService,
    private rpcService: RpcService,
    private windowsService: WindowsService,
  ) { }

  get isAbleToRpc() {
    return this.rpcService.isAbleToRpc;
  }
  get isLoading(): boolean {
    return this.socketService.serversWaiting || this.loadingService.isLoading;
  }

  get serverConnected() {
    return this.socketService.socket?.connected;
  }

  get apiServerConnected() {
    return this.socketService.apiServerConnected;
  }

  get isRPCConnected() {
    return this.rpcService.isConnected;
  }

  get isSynced() {
    return this.rpcService.isSynced;
  }

  get windows() {
    return this.windowsService.tabs;
  }
}
