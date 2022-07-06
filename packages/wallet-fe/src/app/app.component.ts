import { Component, NgZone } from '@angular/core';
import { ConnectionService } from './@core/services/connections.service';
import { RpcService } from './@core/services/rpc.service';

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
  ) {
    this.handleConnections();
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

  get allConnected() {
    return this.isOnline && this.connectionService.isMainSocketConnected;
  }
}
