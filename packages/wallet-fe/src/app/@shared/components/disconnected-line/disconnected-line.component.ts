import { Component, Input, ViewChild } from '@angular/core';
import { ConnectionService } from 'src/app/@core/services/connections.service';
import { SocketService } from 'src/app/@core/services/socket.service';

@Component({
  selector: 'tl-disconnected-line',
  templateUrl: './disconnected-line.component.html',
  styleUrls: ['./disconnected-line.component.scss']
})
export class DisconnectedLineComponent {
  constructor(
      private connectionService: ConnectionService,
      private socketService: SocketService,
  ) { }

  get isOnlineConnected() {
    return this.connectionService.isOnline;
  }

  get isMainSocketConnected() {
    return this.connectionService.isMainSocketConnected;
  }

  mainSocketReconenct() {
    this.socketService.socketConnect();
  }
}
