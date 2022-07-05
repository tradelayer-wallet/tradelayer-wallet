import { THIS_EXPR } from '@angular/compiler/src/output/output_ast';
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
    public servers: string[] = [environment.ENDPOINTS?.[this.network]?.orderbookApiUrl];

    selectedServer: string = this.servers[0];

    constructor(
      private socketService: SocketService,
      private rpcService: RpcService,
    ) {}

    get isConnected() {
      return this.socketService.orderbookServerConnected;
    }

    get network() {
      return this.rpcService.NETWORK as string
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
