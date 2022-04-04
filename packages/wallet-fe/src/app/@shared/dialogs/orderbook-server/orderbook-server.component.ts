import { Component, OnDestroy, OnInit } from '@angular/core';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { SocketService } from 'src/app/@core/services/socket.service';
import { environment } from 'src/environments/environment';

@Component({
  selector: 'orderbook-server-dialog',
  templateUrl: './orderbook-server.component.html',
  styleUrls: ['./orderbook-server.component.scss']
})
export class OrderbookServerDialog implements OnInit, OnDestroy {
    loading: boolean = true;
    public servers: string[] = this.isTestnet
      ? [environment.orderbook_service_url_testnet, 'http://testnet-testurl.com']
      : [environment.orderbook_service_url, 'http://mainet-testUrl.com'];

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
      this.socketService.orderbookServerReconnect(this.selectedServer);
    }

    disconnect() {
      this.socketService.disconenctOrderbook();
    }
}
