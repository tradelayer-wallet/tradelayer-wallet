import { Component, Input, ViewChild } from '@angular/core';
import { ConnectionService } from 'src/app/@core/services/connections.service';

@Component({
  selector: 'tl-disconnected-line',
  templateUrl: './disconnected-line.component.html',
  styleUrls: ['./disconnected-line.component.scss']
})
export class DisconnectedLineComponent {
  constructor(
      private connectionService: ConnectionService,
  ) { }

  get isOnlineConnected() {
    return this.connectionService.isOnline;
  }
}
