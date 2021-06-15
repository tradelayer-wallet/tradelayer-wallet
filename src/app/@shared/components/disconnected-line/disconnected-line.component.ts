import { Component, ViewChild } from '@angular/core';
import { SocketService } from 'src/app/@core/services/socket.service';

@Component({
  selector: 'tl-disconnected-line',
  templateUrl: './disconnected-line.component.html',
  styleUrls: ['./disconnected-line.component.scss']
})
export class DisconnectedLineComponent {
  constructor(
      private socketService: SocketService,
  ) { }

  reconnect() {
    this.socketService.socketConnect();
  }
}
