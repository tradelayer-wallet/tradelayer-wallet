import { Component, Input, ViewChild } from '@angular/core';
import { DealerService } from 'src/app/@core/services/spot-services/dealer.service';
import { SocketService } from 'src/app/@core/services/socket.service';
import { RpcService } from 'src/app/@core/services/rpc.service';

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
      private rpcService: RpcService,
  ) { }

  reconnect() {
    if (this.serverType === 'LOCAL') {
      this.socketService.socketConnect();
    }

    // if (this.serverType === 'ORDERBOOK') {
    //   const isTesNet = this.rpcService.NETWORK === 'LTCTEST';
    //   this.socketService.apiReconnect(isTesNet);
    // }

    if (this.serverType === 'API') {
      const isTesNet = this.rpcService.NETWORK === 'LTCTEST';
      this.socketService.api2Reconnect(isTesNet);
    }    
    this.dealersService.resetDealerTrades();
  }
}
