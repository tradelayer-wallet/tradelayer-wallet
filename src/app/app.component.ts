import { Component } from '@angular/core';
import { RpcService } from './@core/services/rpc.service';
import { environment } from '../environments/environment';
import { SocketService } from './@core/services/socket.service';

@Component({
  selector: 'tl-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent {
  constructor(
    private rpcService: RpcService,
    private socketService: SocketService,
  ) {}

  get serverConnected() {
    return this.socketService.socket?.connected;
  }

  get isConnected() {
    if (environment.rpcRequire === false) return true;
    return this.rpcService.isConnected;
  }
}
