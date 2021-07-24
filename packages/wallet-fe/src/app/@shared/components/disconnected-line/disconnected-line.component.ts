import { Component, ViewChild } from '@angular/core';
import { DealerService } from 'src/app/@core/services/dealer.service';
import { SocketService } from 'src/app/@core/services/socket.service';

@Component({
  selector: 'tl-disconnected-line',
  templateUrl: './disconnected-line.component.html',
  styleUrls: ['./disconnected-line.component.scss']
})
export class DisconnectedLineComponent {
  constructor(
      private socketService: SocketService,
      private dealersService: DealerService,
  ) { }

  reconnect() {
    this.socketService.socketConnect();
    this.dealersService.resetDealerTrades();
  }
}
