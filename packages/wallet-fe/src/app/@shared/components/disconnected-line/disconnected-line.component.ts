import { Component, Input, ViewChild } from '@angular/core';
import { DealerService } from 'src/app/@core/services/dealer.service';
import { SocketService } from 'src/app/@core/services/socket.service';

@Component({
  selector: 'tl-disconnected-line',
  templateUrl: './disconnected-line.component.html',
  styleUrls: ['./disconnected-line.component.scss']
})
export class DisconnectedLineComponent {
  @Input('serverType') serverType: string = '';

  constructor(
      private socketService: SocketService,
      private dealersService: DealerService,
  ) { }

  reconnect() {
    if (this.serverType === 'LOCAL') {
      this.socketService.socketConnect();
    }

    if (this.serverType === 'API') {
      this.socketService.apiReconnect();
    }
    this.dealersService.resetDealerTrades();

  }
}
