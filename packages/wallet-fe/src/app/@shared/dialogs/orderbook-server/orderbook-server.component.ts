import { Component, OnDestroy, OnInit } from '@angular/core';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { SocketService } from 'src/app/@core/services/socket.service';

@Component({
  selector: 'orderbook-server-dialog',
  templateUrl: './orderbook-server.component.html',
  styleUrls: ['./orderbook-server.component.scss']
})
export class OrderbookServerDialog implements OnInit, OnDestroy {
    loading: boolean = true;
    public servers: string[] = this.isTestnet
      ? ['http://ec2-13-40-194-140.eu-west-2.compute.amazonaws.com:75', 'http://testnet-testurl.com']
      : ['http://170.187.147.182:75', 'http://mainet-testUrl.com'];

    selectedServer: string = this.servers[0];

    constructor(
      private socketService: SocketService,
      private rpcService: RpcService,
    ) {}

    get isConnected() {
      return this.socketService.orderbookServerConnected;
    }

    get isTestnet() {
      return this.rpcService.NETWORK === 'LTCTEST';
    }

    ngOnInit() {
      this.connect();
    }

    ngOnDestroy() { }

    select(url: string) {
      if (this.isConnected) return;
      this.selectedServer = url;
    }

    connect() {
      this.socketService.apiReconnect(this.selectedServer);
    }

    disconnect() {
      this.socketService.disconenctOrderbook();
    }
}
