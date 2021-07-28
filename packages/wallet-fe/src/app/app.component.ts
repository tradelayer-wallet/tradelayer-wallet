import { Component } from '@angular/core';
import { LoadingService } from './@core/services/loading.service';
import { RpcService } from './@core/services/rpc.service';

import { SocketService } from './@core/services/socket.service';

@Component({
  selector: 'tl-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent {
  constructor(
    private socketService: SocketService,
    private loadginService: LoadingService,
    private rpcService: RpcService,
  ) { }

  get isLoading(): boolean {
    return this.socketService.serversWaiting || this.loadginService.isLoading;
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
}
